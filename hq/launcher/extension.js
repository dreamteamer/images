// dreamteamer machine — the workspaces on this hosted machine. A workspace is a folder under /workspaces,
// opened in its own tab (?folder=/workspaces/<name>), so each tab is one VS Code window with its own
// CLAUDE.md, skills and chat history. This extension lists them, makes new ones by running the machine's
// own `dt-new` in a terminal (so git's credential prompt reaches the editor), and opens or switches.
// It reads only folder names and package.json's `dreamteamer` key; it never executes workspace content,
// which is why it declares support for untrusted workspaces.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.DT_WORKSPACES_ROOT || '/workspaces';
const HOME = process.env.DT_LAUNCHER_DIR || '/opt/dt-launcher';
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED = new Set(['files', 'lost-found', 'trash']);

/** Every workspace on the machine: visible directories under ROOT except the machine's own. */
function listWorkspaces() {
	let entries = [];
	try { entries = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
	return entries
		.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !RESERVED.has(e.name) && e.name !== 'lost+found')
		.map((e) => {
			const dir = path.join(ROOT, e.name);
			let kind = 'folder';
			try {
				if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dreamteamer) kind = 'dreamteamer';
				else if (fs.existsSync(path.join(dir, '.git'))) kind = 'git';
			} catch {
				if (fs.existsSync(path.join(dir, '.git'))) kind = 'git';
			}
			return { name: e.name, dir, kind };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function currentFolder() {
	const f = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	return f ? f.uri.fsPath : null;
}

class WorkspacesTree {
	constructor() {
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._emitter.event;
	}
	refresh() { this._emitter.fire(); }
	getTreeItem(ws) {
		const item = new vscode.TreeItem(ws.name, vscode.TreeItemCollapsibleState.None);
		const here = currentFolder() === ws.dir;
		item.description = `${ws.kind}${here ? ' · this tab' : ''}`;
		item.tooltip = ws.dir;
		item.iconPath = new vscode.ThemeIcon(ws.kind === 'dreamteamer' ? 'rocket' : ws.kind === 'git' ? 'repo' : 'folder');
		item.contextValue = here ? 'workspace-current' : 'workspace';
		item.command = { command: 'dtMachine.openWorkspace', title: 'Open in new tab', arguments: [ws] };
		return item;
	}
	getChildren() { return listWorkspaces(); }
}

async function askName(prompt) {
	return vscode.window.showInputBox({
		prompt,
		placeHolder: 'my-workspace',
		validateInput: (v) => {
			if (!NAME.test(v)) return '1–40 of a-z, 0-9 and "-", starting with a letter or digit';
			if (RESERVED.has(v)) return `"${v}" is reserved on this machine`;
			if (fs.existsSync(path.join(ROOT, v))) return `${path.join(ROOT, v)} already exists`;
			return null;
		},
	});
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** Runs dt-new in a terminal; when the shell reports the command finished, offers to open the result. */
function runDtNew(name, args, tree) {
	const terminal = vscode.window.createTerminal({ name: `dt-new ${name}`, cwd: ROOT });
	terminal.show();
	const line = ['dt-new', name, ...args].map(shellQuote).join(' ');
	const dest = path.join(ROOT, name);
	const onDone = async () => {
		tree.refresh();
		if (!fs.existsSync(dest)) return;
		const pick = await vscode.window.showInformationMessage(`Workspace ${name} is ready.`, 'Open in new tab', 'Open in this tab');
		if (pick) openFolder(dest, pick === 'Open in new tab');
	};
	const run = (integration) => {
		const exec = integration.executeCommand(line);
		const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
			if (e.execution === exec) { sub.dispose(); if (e.exitCode === 0) onDone(); else tree.refresh(); }
		});
	};
	if (terminal.shellIntegration) return run(terminal.shellIntegration);
	// shell integration arrives a moment after the terminal opens (later still behind a trust prompt)
	let settled = false;
	const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
		if (e.terminal !== terminal || settled) return;
		settled = true; sub.dispose(); run(e.shellIntegration);
	});
	setTimeout(() => {
		if (settled) return;
		settled = true; sub.dispose();
		// no shell integration: run it plainly and refresh the list when the folder appears
		terminal.sendText(line);
		const started = Date.now();
		const timer = setInterval(() => {
			if (fs.existsSync(dest) || Date.now() - started > 10 * 60_000) { clearInterval(timer); tree.refresh(); }
		}, 2000);
	}, 15_000);
}

function openFolder(dir, newTab) {
	return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: newTab });
}

function activate(context) {
	const hosted = process.env.DT_MODE === 'hosted' || fs.existsSync(HOME);
	vscode.commands.executeCommand('setContext', 'dtMachine.hosted', hosted);
	if (!hosted) return;

	const tree = new WorkspacesTree();
	context.subscriptions.push(vscode.window.registerTreeDataProvider('dtMachine.workspaces', tree));
	try {
		const watcher = fs.watch(ROOT, () => tree.refresh());
		context.subscriptions.push({ dispose: () => watcher.close() });
	} catch {
		// no watch: the refresh button and every create still refresh
	}

	// the switcher: every tab shows which workspace it is, one click lists the others
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	const here = currentFolder();
	status.text = `$(server) ${here === HOME ? 'machine home' : here ? path.basename(here) : 'no workspace'}`;
	status.tooltip = 'Switch workspace on this machine';
	status.command = 'dtMachine.switchWorkspace';
	status.show();
	context.subscriptions.push(status);

	const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	reg('dtMachine.refresh', () => tree.refresh());
	reg('dtMachine.newWorkspace', async () => {
		const name = await askName('Name of the new workspace (from the dreamteamer hq template)');
		if (name) runDtNew(name, [], tree);
	});
	reg('dtMachine.newEmptyWorkspace', async () => {
		const name = await askName('Name of the new empty workspace');
		if (name) runDtNew(name, ['--empty'], tree);
	});
	reg('dtMachine.cloneRepository', async () => {
		const url = await vscode.window.showInputBox({
			prompt: 'Repository URL (https://…, ssh://… or git@…). A private HTTPS repository asks for your git login once; it is saved for this whole machine.',
			placeHolder: 'https://bitbucket.org/team/repo.git',
			validateInput: (v) => (/^(https:\/\/|ssh:\/\/|git@)\S+$/.test(v) ? null : 'must start with https://, ssh:// or git@'),
		});
		if (!url) return;
		const guess = (url.replace(/\.git$/, '').split(/[/:]/).pop() || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
		const name = await vscode.window.showInputBox({
			prompt: 'Name of the workspace folder',
			value: guess,
			validateInput: (v) => (!NAME.test(v) ? '1–40 of a-z, 0-9 and "-"' : RESERVED.has(v) ? 'reserved' : fs.existsSync(path.join(ROOT, v)) ? 'already exists' : null),
		});
		if (!name) return;
		const install = await vscode.window.showWarningMessage(
			'If this is a dreamteamer workspace, install and compile it now? That runs code the repository chose. Only for a repository you trust; otherwise open it first, review it, and trust it.',
			{ modal: true },
			'Clone only',
			'Clone, install and compile',
		);
		if (!install) return;
		runDtNew(name, ['--clone', url, ...(install === 'Clone, install and compile' ? ['--install'] : [])], tree);
	});
	reg('dtMachine.openWorkspace', (ws) => ws && openFolder(ws.dir, true));
	reg('dtMachine.openWorkspaceHere', (ws) => ws && openFolder(ws.dir, false));
	reg('dtMachine.openHome', () => openFolder(HOME, false));
	reg('dtMachine.switchWorkspace', async () => {
		const items = [
			...listWorkspaces().map((ws) => ({ label: ws.name, description: ws.kind, ws })),
			{ label: '$(home) machine home', description: 'every workspace, create or clone', home: true },
		];
		const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open which workspace?' });
		if (!pick) return;
		const target = pick.home ? HOME : pick.ws.dir;
		const how = await vscode.window.showQuickPick(['In a new tab', 'In this tab'], { placeHolder: pick.label });
		if (how) openFolder(target, how === 'In a new tab');
	});
	reg('dtMachine.deleteWorkspace', async (ws) => {
		if (!ws || !NAME.test(ws.name) || path.dirname(ws.dir) !== ROOT) return;
		const typed = await vscode.window.showInputBox({
			prompt: `Delete ${ws.dir} and everything in it? This cannot be undone. (Its files folder, /workspaces/.files/${ws.name}, is kept.) Type the name to confirm.`,
			validateInput: (v) => (v === ws.name ? null : `type ${ws.name}`),
		});
		if (typed !== ws.name) return;
		await fs.promises.rm(ws.dir, { recursive: true, force: true });
		tree.refresh();
	});
}

function deactivate() {}

module.exports = { activate, deactivate, listWorkspaces };
