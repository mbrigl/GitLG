let vscode = require('vscode')
let path = require('path')
let postcss = require('postcss')
let postcss_sanitize = require('postcss-sanitize')
let RelativeTime = require('@yaireo/relative-time')
let relative_time = new RelativeTime()
let { compress } = require('compress-json')
require('./globals')

let { get_git } = require('./git')
let create_logger = require('./logger')
let { parse } = require('./log-parser')

let EXT_NAME = 'GitLG'
let EXT_ID = 'git-log--graph'
let START_CMD = EXT_ID + '.start'
let BLAME_CMD = EXT_ID + '.blame-line'

/** @type {vscode.WebviewPanel | vscode.WebviewView | null} */
let webview_container = null

let logger = create_logger(EXT_NAME, EXT_ID)
module.exports.log = logger

/**
 * Necessary because there's no global error handler for VSCode extensions https://github.com/microsoft/vscode/issues/45264
 * and the suggested alternative of installing a TelemetryLogger fails when the user has set {"telemetry.telemetryLevel": "off"}.
 * Also we're not doing any telemetry but only want to catch the errors for better formatting and display.
 * @template {(...args: any[]) => any} Fun
 * @param fun {Fun}
 * @returns {Fun}
 */
function intercept_errors(fun) {
	return /** @type {Fun} */ (async (...args) => { // eslint-disable-line @stylistic/no-extra-parens
		try {
			return await fun(...args)
		} catch (e) {
			logger.error(e)
			// VSCode api callbacks often don't seem to preserve proper stack trace so not even console.trace() in logger helps
			console.error('The above error happened inside:', fun.toString())
			throw e
		}
	})
}

// When you convert a folder into a workspace by adding another folder, the extension is de- and reactivated
// but the webview webview_container isn't destroyed even though we instruct it to (with subscriptions).
// This is an unresolved bug in VSCode and it seems there is nothing you can do. https://github.com/microsoft/vscode/issues/158839
module.exports.activate = intercept_errors(function(/** @type {vscode.ExtensionContext} */ context) {
	logger.info('extension activate')

	function post_message(/** @type {BridgeMessage} */ msg) {
		let str = JSON.stringify(msg)
		// logger.debug('send to webview: ' + str)
		vscode.window.showInformationMessage('sending')
		return webview_container?.webview.postMessage(str)
	}
	function push_message_id(/** @type {string} */ id) {
		return post_message({
			type: 'push-to-web',
			id,
		})
	}

	let git = get_git(EXT_ID, logger, {
		on_repo_external_state_change() {
			return push_message_id('repo-external-state-change')
		},
		on_repo_names_change() {
			return state('repo-names').set(git.get_repo_names())
		},
	})

	// something to be synchronized with the web view - initialization, storage,
	// update and retrieval is supported in both directions
	let state = (() => {
		function global_state_memento(/** @type {string} */ key) {
			return {
				get: () => context.globalState.get(key),
				set: (/** @type {any} */ v) => context.globalState.update(key, v),
			}
		}
		function workspace_state_memento(/** @type {string} */ key) {
			return {
				get: () => context.workspaceState.get(key),
				set: (/** @type {any} */ v) => context.workspaceState.update(key, v),
			}
		}
		function repo_state_memento(/** @type {string} */ local_key) {
			function key() {
				let repo_name = git.get_repo_names()[state('selected-repo-index').get()]
				return `repo-${local_key}-${repo_name}`
			}
			return {
				get: () => context.workspaceState.get(key()),
				set: (/** @type {any} */ v) => context.workspaceState.update(key(), v),
			}
		}
		/** @type {Record<string, {get:()=>any,set:(value:any)=>any}>} */
		let special_states = { // "Normal" states instead are just default_memento

			'selected-repo-index': {
				get: () => context.workspaceState.get('selected-repo-index'),
				set(v) {
					context.workspaceState.update('selected-repo-index', v)
					git.set_selected_repo_index(Number(v) || 0)
					// These will have changed now, so notify clients of updated value

					for (let key of ['repo:action-history', 'repo:selected-commits-hashes'])
						state(key).set(state(key).get())
				},
			},

			'repo-names': {
				get: () => git.get_repo_names(),
				set() {},
			},
			'repo:selected-commits-hashes': repo_state_memento('selected-commits-hashes'),
			'repo:action-history': repo_state_memento('action-history'),
		}
		let default_memento = global_state_memento
		return (/** @type {string} */ key) => {
			let memento = special_states[key] || default_memento(key)
			return {
				get: memento.get,
				set(/** @type {any} */ value, /** @type {{broadcast?:boolean}} */ options = {}) {
					memento.set(value)
					if (options.broadcast !== false)
						post_message({
							type: 'push-to-web',
							id: 'state-update',
							data: { key, value },
						})
				},
			}
		}
	})()

	git.set_selected_repo_index(state('selected-repo-index').get() || 0)

	async function populate_webview() {
		if (! webview_container)
			return

		let view = webview_container.webview
		view.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'web-dist')] }

		view.onDidReceiveMessage(intercept_errors((/** @type {BridgeMessage} */ message) => {
			logger.debug('receive from webview: ' + JSON.stringify(message))
			let d = message.data
			async function h(/** @type {() => any} */ func) {
				/** @type {BridgeMessage} */
				let resp = {
					type: 'response-to-web',
					id: message.id,
				}
				let caller_stack = new Error().stack
				let data = undefined
				try {
					data = await func()
				} catch (error) {
					console.warn(error, caller_stack)
					// We can't really just be passing e along here because it might be serialized as empty {}
					resp.error = error.message || error
				}
				// if (Array.isArray(data)) {
				// 	let max_chunk_size = 5000
				// 	if (data.length > max_chunk_size)
				// 		for (let i = 0; i < data.length; i += max_chunk_size) {
				// 			let chunk = data.slice(i, i + max_chunk_size)
				// 			await post_message({
				// 				...resp,
				// 				data: chunk,
				// 				chunk: i + 1,
				// 				total_chunks: data.length,
				// 			})
				// 		}
				// } else {
				resp.data = data
				post_message(resp)
				// }
			}
			switch (message.type) {
				case 'request-from-web':
					switch (message.command) {
						case 'git': return h(() =>
							git.run(d))
						case 'git-log': return h(async () => {
							let { args, fetch_stash_refs, fetch_branches } = d
							let sep = '^%^%^%^%^'
							args = args.replace(' --pretty={EXT_FORMAT}', ` --pretty=format:"${sep}%H${sep}%h${sep}%aN${sep}%aE${sep}%ad${sep}%D${sep}%s"`)
							let stash_refs = ''
							if (fetch_stash_refs)
								stash_refs = await git.run('stash list --format="%h"')
							args = args.replace('{STASH_REFS}', stash_refs.replaceAll('\n', ' '))
							let [log_data, branch_data, stash_data] = await Promise.all([
								git.run(args),
								fetch_branches ? git.run(`branch --list --all --format="%(upstream:remotename)${sep}%(refname)"`) : '',
								git.run('stash list --format="%h %gd"').catch(() => ''),
							])
							/** @type {ReturnType<parse>} */
							let parsed = { commits: [], refs: [] }
							if (log_data)
								parsed = parse(log_data, branch_data, stash_data, sep, vscode.workspace.getConfiguration(EXT_ID)['curve-radius'])
							// return compress(parsed)
							return parsed
						})
						case 'show-error-message': return h(() =>
							logger.error(d))
						case 'show-information-message': return h(() =>
							vscode.window.showInformationMessage(d))
						case 'get-config': return h(() =>
							vscode.workspace.getConfiguration(EXT_ID))
						case 'get-state': return h(() =>
							state(d).get())
						case 'set-state': return h(() =>
							state(d.key).set(d.value, { broadcast: false }))
						case 'open-diff': return h(() => {
							let uri_1 = vscode.Uri.parse(`${EXT_ID}-git-show:${d.hashes[0]}:${d.filename}`)
							let uri_2 = vscode.Uri.parse(`${EXT_ID}-git-show:${d.hashes[1]}:${d.filename}`)
							return vscode.commands.executeCommand('vscode.diff', uri_1, uri_2, `${d.filename} ${d.hashes[0]} vs. ${d.hashes[1]}`)
						})
						case 'open-multi-diff': return h(() =>
							vscode.commands.executeCommand('vscode.changes',
								`${d.hashes[0]} vs. ${d.hashes[1]}`,
								d.filenames.map((/** @type {string} */ filename) => [
									vscode.Uri.parse(filename),
									vscode.Uri.parse(`${EXT_ID}-git-show:${d.hashes[0]}:${filename}`),
									vscode.Uri.parse(`${EXT_ID}-git-show:${d.hashes[1]}:${filename}`),
								])))
						case 'view-rev': return h(() => {
							let uri = vscode.Uri.parse(`${EXT_ID}-git-show:${d.hash}:${d.filename}`)
							return vscode.commands.executeCommand('vscode.open', uri)
						})
						case 'open-file': return h(() => {
							// vscode.workspace.workspaceFolders is NOT necessarily in the same order as git-api.repositories
							let workspace = git.get_repo()?.rootUri.fsPath || ''
							let uri = vscode.Uri.file(path.join(workspace, d.filename))
							return vscode.commands.executeCommand('vscode.open', uri)
						})
					}
			}
		}))

		vscode.workspace.onDidChangeConfiguration(intercept_errors((event) => {
			if (event.affectsConfiguration(EXT_ID))
				debounce(intercept_errors(() => push_message_id('config-change')), 500)
		}))

		let is_production = context.extensionMode === vscode.ExtensionMode.Production || process.env.GIT_LOG__GRAPH_MODE === 'production'
		let dev_server_url = 'http://localhost:5173'

		let csp = 'default-src \'none\'; ' +
			`style-src ${view.cspSource} 'unsafe-inline' ` +
				(is_production ? '' : dev_server_url) + '; ' +
			`script-src ${view.cspSource} 'unsafe-inline' blob: ` +
				(is_production ? '' : `${dev_server_url} 'unsafe-eval'`) + '; ' +
			`font-src ${view.cspSource} ` +
				(is_production ? '' : dev_server_url) + '; ' +
			'connect-src ' +
				(is_production ? '' : '*') + '; ' +
			`img-src ${view.cspSource} ` +
				(is_production ? '' : dev_server_url) + '; '
		let base_url = is_production
			? view.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'web-dist')) + '/'
			: dev_server_url
		let custom_css = vscode.workspace.getConfiguration(EXT_ID).get('custom-css')
		if (custom_css)
			custom_css = await postcss([postcss_sanitize({})]).process(custom_css, { from: undefined }).then((c) => c.css).maybe()
		let loading_prompt = is_production
			? 'Loading (this should not take long)'
			: 'Trying to connect to dev server... See CONTRIBUTING.md > "Building" for instructions'

		view.html = `
			<!DOCTYPE html>
			<html lang='en'>
			<head>
				<meta charset='UTF-8'>
				<meta http-equiv='Content-Security-Policy' content="${csp}">
				<meta name='viewport' content='width=device-width, initial-scale=1.0'>
				<base href="${base_url}" />
				<link href='./index.css' rel='stylesheet' crossorigin>
				<title>${EXT_NAME}</title>
				<script type="module" crossorigin src='./index.js'></script>
			</head>
			<body>
			<div id='app'>
				<p style="color: grey;">${loading_prompt}</p>
			</div>
			<style>${custom_css}</style>
			</body>
			</html>`
	}

	// Needed for git diff views
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(`${EXT_ID}-git-show`, {
		provideTextDocumentContent: intercept_errors((uri) =>
			git.run(`show "${uri.path}"`).catch(() => ''),
		),
	}))

	// General start, will choose from creating/show editor panel or showing side nav view depending on config
	context.subscriptions.push(vscode.commands.registerCommand(START_CMD, intercept_errors(async (args) => {
		logger.info('start command')
		if (args?.rootUri) // invoked via menu scm/title
			state('selected-repo-index').set(await git.get_repo_index_for_uri(args.rootUri))
		if (vscode.workspace.getConfiguration(EXT_ID).get('position') === 'editor') {
			if (webview_container)
				// Repeated editor panel show
				return /** @type {vscode.WebviewPanel} */ (webview_container).reveal() // eslint-disable-line @stylistic/no-extra-parens
			// First editor panel creation + show
			logger.info('create new webview panel')
			webview_container = vscode.window.createWebviewPanel(EXT_ID, EXT_NAME, vscode.window.activeTextEditor?.viewColumn || 1, { retainContextWhenHidden: true })
			webview_container.iconPath = vscode.Uri.joinPath(context.extensionUri, 'img', 'logo.png')
			webview_container.onDidDispose(() => { webview_container = null })
			context.subscriptions.push(webview_container)
			return populate_webview()
		} else {
			// Repeated side nav view show
			logger.info('show view');
			/** @type {vscode.WebviewView | null} */ (webview_container)?.show() // eslint-disable-line @stylistic/no-extra-parens
		}
	})))

	// Close the editor(tab)
	context.subscriptions.push(vscode.commands.registerCommand('git-log--graph.close', intercept_errors(() => {
		if (vscode.workspace.getConfiguration(EXT_ID).get('position') !== 'editor')
			return vscode.window.showInformationMessage('This command can only be used if GitLG isn\'t configured as a main editor (tab).')
		if (! webview_container)
			return vscode.window.showInformationMessage('GitLG editor tab is not running.')
		logger.info('close command');
		/** @type {vscode.WebviewPanel} */ (webview_container).dispose() // eslint-disable-line @stylistic/no-extra-parens
	})))

	// Toggle the editor(tab)
	context.subscriptions.push(vscode.commands.registerCommand('git-log--graph.toggle', intercept_errors(() => {
		if (vscode.workspace.getConfiguration(EXT_ID).get('position') !== 'editor')
			return vscode.window.showInformationMessage('This command can only be used if GitLG isn\'t configured as a main editor (tab).')
		logger.info('toggle command')
		if (webview_container)
			/** @type {vscode.WebviewPanel} */ (webview_container).dispose() // eslint-disable-line @stylistic/no-extra-parens
		return vscode.commands.executeCommand(START_CMD)
	})))

	// First editor panel creation + show, but automatically after restart / resume previous session.
	// It would be possible to restore some web view state here too
	vscode.window.registerWebviewPanelSerializer(EXT_ID, {
		deserializeWebviewPanel: intercept_errors((deserialized_panel) => {
			logger.info('deserialize web panel (rebuild editor tab from last session)')
			webview_container = deserialized_panel
			webview_container.onDidDispose(() => { webview_container = null })
			context.subscriptions.push(webview_container)
			populate_webview()
			return Promise.resolve()
		}),
	})

	// Side nav view setup
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(EXT_ID, {
		// Side nav view creation
		resolveWebviewView: intercept_errors((view) => {
			if (vscode.workspace.getConfiguration(EXT_ID).get('position') === 'editor')
				return
			logger.info('provide view')
			webview_container = view
			return populate_webview()
		}),
	}, { webviewOptions: { retainContextWhenHidden: true } }))

	let status_bar_item_command = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
	status_bar_item_command.command = START_CMD
	context.subscriptions.push(status_bar_item_command)
	status_bar_item_command.text = '$(git-branch) GitLG'
	status_bar_item_command.tooltip = 'Open up the main view of the GitLG extension'
	status_bar_item_command.show()

	let status_bar_item_blame = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 500)
	status_bar_item_blame.command = BLAME_CMD
	context.subscriptions.push(status_bar_item_blame)
	status_bar_item_blame.text = ''
	status_bar_item_blame.tooltip = 'Show and focus this commit in the main view of the GitLG extension'
	status_bar_item_blame.show()

	let current_line = -1
	let current_line_repo_index = -1
	let current_line_long_hash = ''
	/** @type {NodeJS.Timeout|null} */
	let line_change_debouncer = null
	function hide_blame() {
		if (line_change_debouncer)
			clearTimeout(line_change_debouncer)
		current_line_long_hash = ''
		status_bar_item_blame.text = ''
	}
	vscode.workspace.onDidCloseTextDocument(intercept_errors(hide_blame))
	vscode.window.onDidChangeActiveTextEditor(intercept_errors(hide_blame))
	vscode.window.onDidChangeTextEditorSelection(intercept_errors(({ textEditor: text_editor }) => {
		let doc = text_editor.document
		let uri = doc.uri
		if (uri.scheme !== 'file' || doc.languageId === 'log' || doc.languageId === 'Log' || uri.path.includes('extension-output') || uri.path.includes(EXT_ID)) // vscode/issues/206118
			return
		if (text_editor.selection.active.line === current_line)
			return
		current_line = text_editor.selection.active.line
		if (line_change_debouncer)
			clearTimeout(line_change_debouncer)
		line_change_debouncer = setTimeout(intercept_errors(async () => {
			current_line_repo_index = await git.get_repo_index_for_uri(uri)
			if (current_line_repo_index < 0)
				return hide_blame()
			let blamed = await git.run(`blame -L${current_line + 1},${current_line + 1} --porcelain -- ${uri.fsPath}`, current_line_repo_index)
				.then((b) => b.split('\n')).maybe()
			if (! blamed)
				return hide_blame()
			// apparently impossible to get the short form right away in easy machine readable format?
			current_line_long_hash = blamed[0].slice(0, 40)
			let author = blamed[1].slice(7)
			let time = relative_time.from(new Date(Number(blamed[3].slice(12)) * 1000))
			status_bar_item_blame.text = `$(git-commit) ${author}, ${time}`
		}), 150)
	}))
	context.subscriptions.push(vscode.commands.registerCommand(BLAME_CMD, intercept_errors(async () => {
		logger.info('blame cmd')
		if (! current_line_long_hash)
			return
		state('selected-repo-index').set(current_line_repo_index)
		let focus_commit_hash = ((await git.run(`rev-parse --short ${current_line_long_hash}`))).trim()
		current_line_long_hash = ''
		state('repo:selected-commits-hashes').set([focus_commit_hash])
		vscode.commands.executeCommand(START_CMD)
		return push_message_id('scroll-to-selected-commit')
	})))

	context.subscriptions.push(vscode.commands.registerCommand('git-log--graph.refresh', intercept_errors(() => {
		logger.info('refresh command')
		return push_message_id('refresh-main-view')
	})))

	// public api of this extension:
	return { git, post_message, webview_container, context, state }
})

module.exports.deactivate = function() {
	return logger.info('extension deactivate')
}
