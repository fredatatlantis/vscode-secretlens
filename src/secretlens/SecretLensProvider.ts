import { SecretLensFunction } from './SecretLensFunction';
import * as interfaces from './interfaces';
import * as clipboardy from 'clipboardy'
import * as vscode from 'vscode';
/**
 * SecretLensProvider
 */
export class SecretLensProvider implements vscode.CodeLensProvider, vscode.Disposable, vscode.HoverProvider {

    private regex: RegExp
    private disposables: vscode.Disposable[] = []
    private secretLensFunction: SecretLensFunction
    private codeLenses: vscode.CodeLens[]
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>()
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event
    private config: vscode.WorkspaceConfiguration

    constructor() {
        this.configLoaded()
        this.secretLensFunction = new SecretLensFunction(this)
    }

    reload() {
        this._onDidChangeCodeLenses.fire()
    }

    private configLoaded() {
        this.config = vscode.workspace.getConfiguration("secretlens")
        this.regex = new RegExp(`${this.startToken}.+(${this.endToken})?`, "g")
        this.forgetPassword(true)
    }
    private get startToken() {
        return this.config.get('token') + ":"
    }

    private get endToken() {
        return ":" + this.config.get('token')
    }

    private removeTokens(text: string): string {
        return text.replace(this.startToken, "").replace(this.endToken, "")
    }

    public register() {
        var languages: string[] = this.config.get('languages');

        switch (this.config.get<string>('displayType').toUpperCase()) {
            case 'HOVER':
                this.disposables.push(vscode.languages.registerHoverProvider(languages, this));
                break;
            case 'BOTH':
                this.disposables.push(vscode.languages.registerHoverProvider(languages, this));
                this.disposables.push(vscode.languages.registerCodeLensProvider(languages, this));
                break;
            default:
                this.disposables.push(vscode.languages.registerCodeLensProvider(languages, this));
                break;
        }

        this.disposables.push(vscode.commands.registerCommand('secretlens.encrypt', this.encrypt, this))
        this.disposables.push(vscode.commands.registerCommand('secretlens.decrypt', this.decrypt, this))
        this.disposables.push(vscode.commands.registerCommand('secretlens.setPassword', this.setPassword, this))
        this.disposables.push(vscode.commands.registerCommand('secretlens.forgetPassword', this.forgetPassword, this))
        this.disposables.push(vscode.commands.registerTextEditorCommand('secretlens.copySecret', this.copySecret, this))

        vscode.workspace.onDidChangeConfiguration((event) => {
            this.configLoaded()
        })
    }

    private copySecret(editor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
        this.askPassword().then(() => {
            let decrypted = []
            editor.selections.forEach(selection => {
                let line = vscode.window.activeTextEditor.document.lineAt(selection.start.line)
                const regex = new RegExp(this.regex)
                let text = line.text
                let match;
                while ((match = regex.exec(text)) !== null) {
                    let text = this.removeTokens(match[0])
                    decrypted.push(this.secretLensFunction.decrypt(text))
                }
            });
            let copySeparator: string = this.config.get("copySeparator")
            clipboardy.write(decrypted.join(copySeparator))
        });
    }

    public getFunction(): SecretLensFunction {
        return this.secretLensFunction
    }

    private setPassword(): Thenable<void> {
        return this.secretLensFunction.askPassword().then(() => {
            this.forgetPassword(true)
            return Promise.resolve()
        })
    }

    private forgetPassword(wait = null) {
        let rememberPeriod: Number = this.config.get("rememberPeriod")
        if (!wait) {
            this.secretLensFunction.forgetPassword()
        } else if (wait && rememberPeriod >= 0) {
            let forgetInMilliseconds = rememberPeriod.valueOf() * 1000
            setTimeout(() => {
                this.secretLensFunction.forgetPassword()
            }, forgetInMilliseconds)
        }
    }

    private askPassword(): Thenable<void> {
        if (this.secretLensFunction.shouldAskForPassword) {
            return this.setPassword()
        }
        return Promise.resolve()
    }

    private encrypt(): void {
        let replaces = []
        this.askPassword().then(() => {
            let editor = vscode.window.activeTextEditor
            editor.edit((edits) => {
                editor.selections.forEach(selection => {
                    var range = new vscode.Range(selection.start, selection.end);
                    if (selection.isEmpty) {
                        range = editor.document.lineAt(selection.start.line).range
                    }
                    var text = editor.document.getText(range)

                    if (!this.regex.test(text) && text.length > 0) {
                        var encrypted = this.secretLensFunction.encrypt(text)
                        var text = this.startToken + encrypted + (!this.config.get("excludeEnd") ? this.endToken : "")
                        edits.replace(range, text)
                        replaces.push(new vscode.Selection(range.start, range.start.translate(0, text.length)))
                    }
                })
            }).then(() => {
                editor.selections = replaces
            })
        })
    }

    private decrypt(): void {
        let replaces = []
        this.askPassword().then(() => {
            let editor = vscode.window.activeTextEditor
            editor.edit(edits => {
                editor.selections.forEach(selection => {
                    let line = editor.document.lineAt(selection.start.line)
                    const regex = new RegExp(this.regex)
                    let text = line.text
                    let match;
                    while ((match = regex.exec(text)) !== null) {
                        let text = this.removeTokens(match[0])
                        let index = line.text.indexOf(match[0])
                        let position = new vscode.Position(line.lineNumber, index)
                        let range = editor.document.getWordRangeAtPosition(position, new RegExp(this.regex))

                        edits.replace(range, this.secretLensFunction.decrypt(text))
                        replaces.push(new vscode.Selection(range.start, range.start.translate(0, this.secretLensFunction.decrypt(text).length)))
                    }
                })
            }).then(() => {
                editor.selections = replaces
            })
        })
    }

    public dispose() {
        if (this.disposables) {
            this.disposables.forEach(item => item.dispose())
            this.disposables = null
        }
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        this.codeLenses = [];
        const regex = new RegExp(this.regex)
        const text = document.getText()
        let matches;
        while ((matches = regex.exec(text)) !== null) {
            let line = document.lineAt(document.positionAt(matches.index).line);
            let indexOf = line.text.indexOf(matches[0])
            let position = new vscode.Position(line.lineNumber, indexOf)
            let range = document.getWordRangeAtPosition(position, new RegExp(this.regex))
            this.codeLenses.push(new vscode.CodeLens(range));
        }
        return this.codeLenses;
    }

    public resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken) {
        var text = vscode.window.activeTextEditor.document.getText(codeLens.range);

        if (this.secretLensFunction.shouldAskForPassword) {
            codeLens.command = {
                title: "Password not set: click here to set",
                command: 'secretlens.setPassword'
            }
        } else {
            let decrypted: string
            try {
                decrypted = this.secretLensFunction.decrypt(this.removeTokens(text))
                codeLens.command = {
                    title: decrypted,
                    command: 'secretlens.copySecret'
                }
            } catch (error) {
                codeLens.command = {
                    title: 'Failed to decrypt the message (the password is correct?)',
                    command: 'secretlens.setPassword'
                }
            }
        }
        return codeLens;
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        let line = document.lineAt(position);
        let text = this.secretLensFunction.decrypt(this.removeTokens(line.text));
        return new vscode.Hover(text, line.range)
    }
}

