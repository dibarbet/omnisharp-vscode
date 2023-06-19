/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { registerCommands } from './commands';
import { registerDebugger } from './debugger';
import { UriConverter } from './uriConverter';

import {
    LanguageClientOptions,
    ServerOptions,
    State,
    Trace,
    RequestType,
    RequestType0,
} from 'vscode-languageclient/node';
import { PlatformInformation } from '../shared/platform';
import { acquireDotNetProcessDependencies } from './dotnetRuntime';
import { readConfigurations } from './configurationMiddleware';
import OptionProvider from '../shared/observers/OptionProvider';
import ShowInformationMessage from '../shared/observers/utils/ShowInformationMessage';
import EventEmitter = require('events');
import Disposable from '../Disposable';
import { RegisterSolutionSnapshotRequest, ProjectInitializationCompleteNotification } from './roslynProtocol';
import { OpenSolutionParams } from './OpenSolutionParams';
import { CSharpDevKitExports } from '../CSharpDevKitExports';
import { ISolutionSnapshotProvider, SolutionSnapshotId } from './services/ISolutionSnapshotProvider';
import { Options } from '../shared/options';
import { ServerStateChange } from './ServerStateChange';
import TelemetryReporter from '@vscode/extension-telemetry';
import CSharpIntelliCodeExports from '../CSharpIntelliCodeExports';
import { csharpDevkitExtensionId, getCSharpDevKit } from '../utils/getCSharpDevKit';
import { randomUUID } from 'crypto';
import { RoslynLanguageClientInstance } from './roslynLanguageClient';

let _languageServer: RoslynLanguageServer;
let _channel: vscode.OutputChannel;
let _traceChannel: vscode.OutputChannel;

export const CSharpDevkitIntelliCodeExtensionId = "ms-dotnettools.vscodeintellicode-csharp";

export class RoslynLanguageServer {

    /**
     * Event name used to fire events to the _eventBus when the server state changes.
     */
    private static readonly serverStateChangeEvent: string = "serverStateChange";

    /**
     * The timeout for stopping the language server (in ms).
     */
    private static _stopTimeout: number = 10000;
    private _languageClient: RoslynLanguageClientInstance | undefined;

    /**
     * Flag indicating if C# Devkit was installed the last time we activated.
     * Used to determine if we need to restart the server on extension changes.
     */
    private _wasActivatedWithCSharpDevkit: boolean | undefined;

    /**
     * Event emitter that fires events when state related to the server changes.
     * For example when the server starts or stops.
     *
     * Consumers can register to listen for these events if they need to.
     */
    private _eventBus = new EventEmitter();

    /**
     * The solution file previously opened; we hold onto this so we can send this back over if the server were to be relaunched for any reason, like some other configuration
     * change that required the server to restart, or some other catastrophic failure that completely took down the process. In the case that the process is crashing because
     * of trying to load this solution file, we'll rely on VS Code's support to eventually stop relaunching the LSP server entirely.
     */
    private _solutionFile: vscode.Uri | undefined;

    constructor(
        private platformInfo: PlatformInformation,
        private optionProvider: OptionProvider,
        private context: vscode.ExtensionContext,
        private telemetryReporter: TelemetryReporter
    ) { }

    /**
     * Resolves server options and starts the dotnet language server process. The process is started asynchronously and this method will not wait until
     * the process is launched.
     */
    public start(): void {
        let options = this.optionProvider.GetLatestOptions();
        let logLevel = options.languageServerOptions.logLevel;
        const languageClientTraceLevel = this.GetTraceLevel(logLevel);

        let serverOptions: ServerOptions = async () => {
            return await this.startServer(logLevel);
        };

        let documentSelector = options.languageServerOptions.documentSelector;

        // Options to control the language client
        let clientOptions: LanguageClientOptions = {
            // Register the server for plain csharp documents
            documentSelector: documentSelector,
            synchronize: {
                // Notify the server about file changes to '.clientrc files contain in the workspace
                fileEvents: vscode.workspace.createFileSystemWatcher('**/*.*')
            },
            traceOutputChannel: _traceChannel,
            outputChannel: _channel,
            uriConverters: {
                // VSCode encodes the ":" as "%3A" in file paths, for example "file:///c%3A/Users/dabarbet/source/repos/ConsoleApp8/ConsoleApp8/Program.cs".
                // System.Uri does not decode the LocalPath property correctly into a valid windows path, instead you get something like
                // "/c:/Users/dabarbet/source/repos/ConsoleApp8/ConsoleApp8/Program.cs" (note the incorrect forward slashes and prepended "/").
                // Properly decoded, it would look something like "c:\Users\dabarbet\source\repos\ConsoleApp8\ConsoleApp8\Program.cs"
                // So instead we decode the URI here before sending to the server.
                code2Protocol: UriConverter.serialize,
                protocol2Code: UriConverter.deserialize,
            },
            middleware: {
                workspace: {
                    configuration: (params) => readConfigurations(params),
                }
            }
        };

        // Create the language client and start the client.
        let client = new RoslynLanguageClientInstance(
            'microsoft-codeanalysis-languageserver',
            'Microsoft.CodeAnalysis.LanguageServer',
            serverOptions,
            clientOptions
        );

        client.registerProposedFeatures();

        this._languageClient = client;

        // Set the language client trace level based on the log level option.
        // setTrace only works after the client is already running.
        // We don't use registerOnStateChange here because we need to access the actual _languageClient instance.
        this._languageClient.onDidChangeState(async (state) => {
            if (state.newState === State.Running) {
                await this._languageClient!.setTrace(languageClientTraceLevel);
                if (this._solutionFile) {
                    await this.sendOpenSolutionNotification();
                } else {
                    await this.openDefaultSolution();
                }
                await this.sendOrSubscribeForServiceBrokerConnection();
                this._eventBus.emit(RoslynLanguageServer.serverStateChangeEvent, ServerStateChange.Started);
            }
        });

        this._languageClient.onNotification(ProjectInitializationCompleteNotification.type, () => {
           this._eventBus.emit(RoslynLanguageServer.serverStateChangeEvent, ServerStateChange.ProjectInitializationComplete);
        });

        this.registerExtensionsChanged(this._languageClient);
        this.registerTelemtryChanged(this._languageClient);

        // Start the client. This will also launch the server
        this._languageClient.start();

        // Register Razor dynamic file info handling
        this.registerRazor(this._languageClient);
    }

    public async stop(): Promise<void> {
        await this._languageClient?.stop(RoslynLanguageServer._stopTimeout);
        this._languageClient?.dispose(RoslynLanguageServer._stopTimeout);
        this._languageClient = undefined;
    }

    /**
     * Restarts the language server. This does not wait until the server has been restarted.
     * Note that since some options affect how the language server is initialized, we must
     * re-create the LanguageClient instance instead of just stopping/starting it. 
     */
    public async restart(): Promise<void> {
        await this.stop();
        this.start();
    }

    /**
     * Allows consumers of this server to register for state change events.
     * These state change events will be registered each time the underlying _languageClient instance is created.
     */
    public registerStateChangeEvent(listener: (event: ServerStateChange) => Promise<any>): Disposable {
        this._eventBus.addListener(RoslynLanguageServer.serverStateChangeEvent, listener);
        return new Disposable(() => this._eventBus.removeListener(RoslynLanguageServer.serverStateChangeEvent, listener));
    }

    /**
     * Returns whether or not the underlying LSP server is running or not.
     */
    public isRunning(): boolean {
        return this._languageClient?.state === State.Running;
    }

    /**
     * Makes an LSP request to the server with a given type and parameters.
     */
    public async sendRequest<Params, Response, Error>(type: RequestType<Params, Response, Error>, params: Params, token: vscode.CancellationToken): Promise<Response> {
        if (!this.isRunning()) {
            throw new Error('Tried to send request while server is not started.');
        }

        let response = await this._languageClient!.sendRequest(type, params, token);
        return response;
    }

    /**
     * Makes an LSP request to the server with a given type and no parameters
     */
    public async sendRequest0<Response, Error>(type: RequestType0<Response, Error>, token: vscode.CancellationToken): Promise<Response> {
        if (!this.isRunning()) {
            throw new Error('Tried to send request while server is not started.');
        }

        let response = await this._languageClient!.sendRequest(type, token);
        return response;
    }

    public async registerSolutionSnapshot(token: vscode.CancellationToken) : Promise<SolutionSnapshotId> {
        let response = await _languageServer.sendRequest0(RegisterSolutionSnapshotRequest.type, token);
        if (response)
        {
            return new SolutionSnapshotId(response.id);
        }

        throw new Error('Unable to retrieve current solution.');
    }

    public async openSolution(solutionFile: vscode.Uri): Promise<void> {
        this._solutionFile = solutionFile;
        await this.sendOpenSolutionNotification();
    }

    private async sendOpenSolutionNotification(): Promise<void>  {
        if (this._solutionFile !== undefined && this._languageClient !== undefined && this._languageClient.isRunning()) {
            let protocolUri = this._languageClient.clientOptions.uriConverters!.code2Protocol(this._solutionFile);
            await this._languageClient.sendNotification("solution/open", new OpenSolutionParams(protocolUri));
        }
    }

    private async openDefaultSolution(): Promise<void> {
        const options = this.optionProvider.GetLatestOptions();

        // If Dev Kit isn't installed, then we are responsible for picking the solution to open, assuming the user hasn't explicitly
        // disabled it.
        if (!this._wasActivatedWithCSharpDevkit && options.commonOptions.defaultSolution !== 'disable' && this._solutionFile === undefined) {
            if (options.commonOptions.defaultSolution !== '') {
                this.openSolution(vscode.Uri.file(options.commonOptions.defaultSolution));
            } else {
                // Auto open if there is just one solution target; if there's more the one we'll just let the user pick with the picker.
                const solutionUris = await vscode.workspace.findFiles('**/*.sln', '**/node_modules/**', 2);
                if (solutionUris && solutionUris.length === 1) {
                    this.openSolution(solutionUris[0]);
                }
            }
        }
    }

    private async sendOrSubscribeForServiceBrokerConnection(): Promise<void>  {
        const csharpDevKitExtension = vscode.extensions.getExtension<CSharpDevKitExports>(csharpDevkitExtensionId);
        if (csharpDevKitExtension) {
            const exports = await csharpDevKitExtension.activate();

            // If the server process has already loaded, we'll get the pipe name and send it over to our process; otherwise we'll wait until the Dev Kit server
            // is launched and then send the pipe name over. This avoids us calling getBrokeredServiceServerPipeName() which will launch the server
            // if it's not already running. The rationale here is if Dev Kit is installed, we defer to it for the project system loading; if it's not loaded,
            // then we have no projects, and so this extension won't have anything to do.
            if (exports.hasServerProcessLoaded()) {
                const pipeName = await exports.getBrokeredServiceServerPipeName();
                this._languageClient?.sendNotification("serviceBroker/connect", { pipeName: pipeName });
            } else {
                // We'll subscribe if the process later launches, and call this function again to send the pipe name.
                this.context.subscriptions.push(exports.serverProcessLoaded(async() => this.sendOrSubscribeForServiceBrokerConnection()));
            }
        }
    }

    public getServerCapabilities() : any {
        if (!this._languageClient) {
            throw new Error('Tried to send request while server is not started.');
        }

        let capabilities: any = this._languageClient.initializeResult?.capabilities;
        return capabilities;
    }

    private getServerPath(options: Options) {
        let clientRoot = __dirname;

        let serverPath = options.commonOptions.serverPath;
        if (!serverPath) {
            // Option not set, use the path from the extension.
            serverPath = path.join(clientRoot, '..', '.roslyn', this.getServerFileName());
        }

        if (!fs.existsSync(serverPath)) {
            throw new Error(`Cannot find language server in path '${serverPath}'`);
        }

        return serverPath;
    }

    private async startServer(logLevel: string | undefined): Promise<cp.ChildProcess> {

        let options = this.optionProvider.GetLatestOptions();
        let serverPath = this.getServerPath(options);

        let dotnetRuntimePath = options.commonOptions.dotnetPath;
        if (!dotnetRuntimePath)
        {
            let dotnetPath = await acquireDotNetProcessDependencies(serverPath);
            dotnetRuntimePath = path.dirname(dotnetPath);
        }

        const dotnetExecutableName = this.platformInfo.isWindows() ? 'dotnet.exe' : 'dotnet';
        const dotnetExecutablePath = path.join(dotnetRuntimePath, dotnetExecutableName);
        if (!fs.existsSync(dotnetExecutablePath)) {
            throw new Error(`Cannot find dotnet path '${dotnetExecutablePath}'`);
        }

        _channel.appendLine("Dotnet path: " + dotnetExecutablePath);

        // Take care to always run .NET processes on the runtime that we intend.
        // The dotnet.exe we point to should not go looking for other runtimes.
        const env: NodeJS.ProcessEnv =  { ...process.env };
        env.DOTNET_ROOT = dotnetRuntimePath;
        env.DOTNET_MULTILEVEL_LOOKUP = '0';
        // Save user's DOTNET_ROOT env-var value so server can recover the user setting when needed
        env.DOTNET_ROOT_USER = process.env.DOTNET_ROOT ?? 'EMPTY';

        let args: string[] = [ ];

        if (options.commonOptions.waitForDebugger) {
            args.push("--debug");
        }

        if (logLevel) {
            args.push("--logLevel", logLevel);
        }

        // Get the brokered service pipe name from C# Dev Kit (if installed).
        // We explicitly call this in the LSP server start action instead of awaiting it
        // in our activation because C# Dev Kit depends on C# activation completing.
        const csharpDevkitExtension = vscode.extensions.getExtension<CSharpDevKitExports>(csharpDevkitExtensionId);
        if (csharpDevkitExtension) {
            this._wasActivatedWithCSharpDevkit = true;

            // Get the starred suggestion dll location from C# Dev Kit IntelliCode (if both C# Dev Kit and C# Dev Kit IntelliCode are installed).
            const csharpDevkitIntelliCodeExtension = vscode.extensions.getExtension<CSharpIntelliCodeExports>(CSharpDevkitIntelliCodeExtensionId);
            if (csharpDevkitIntelliCodeExtension) {
                _channel.appendLine("Activating C# + C# Dev Kit + C# IntelliCode...");
                const csharpDevkitIntelliCodeArgs = await this.getCSharpDevkitIntelliCodeExportArgs(csharpDevkitIntelliCodeExtension);
                args = args.concat(csharpDevkitIntelliCodeArgs);
            } else {
                _channel.appendLine("Activating C# + C# Dev Kit...");
            }

            const csharpDevkitArgs = await this.getCSharpDevkitExportArgs(csharpDevkitExtension, options);
            args = args.concat(csharpDevkitArgs);
        } else {
            // C# Dev Kit is not installed - continue C#-only activation.
            _channel.appendLine("Activating C# standalone...");
            vscode.commands.executeCommand("setContext", "dotnet.server.activatedStandalone", true);
            this._wasActivatedWithCSharpDevkit = false;
        }

        if (logLevel && [Trace.Messages, Trace.Verbose].includes(this.GetTraceLevel(logLevel))) {
            _channel.appendLine(`Starting server at ${serverPath}`);
        }

        // shouldn't this arg only be set if it's running with CSDevKit?
        args.push("--telemetryLevel", this.telemetryReporter.telemetryLevel);

        let childProcess: cp.ChildProcessWithoutNullStreams;
        let cpOptions: cp.SpawnOptionsWithoutStdio = {
            detached: true,
            windowsHide: true,
            env: env
        };

        if (serverPath.endsWith('.dll')) {
            // If we were given a path to a dll, launch that via dotnet.
            const argsWithPath = [ serverPath ].concat(args);
            childProcess = cp.spawn('dotnet', argsWithPath, cpOptions);
        } else {
            // Otherwise assume we were given a path to an executable.
            childProcess = cp.spawn(serverPath, args, cpOptions);
        }

        return childProcess;
    }

    private registerExtensionsChanged(languageClient: RoslynLanguageClientInstance) {
        // subscribe to extension change events so that we can get notified if C# Dev Kit is added/removed later.
        languageClient.addDisposable(vscode.extensions.onDidChange(async () => {
            let csharpDevkitExtension = getCSharpDevKit();

            if (this._wasActivatedWithCSharpDevkit === undefined) {
                // Haven't activated yet.
                return;
            }

            const title = 'Restart Language Server';
            const command = 'dotnet.restartServer';
            if (csharpDevkitExtension && !this._wasActivatedWithCSharpDevkit) {
                // We previously started without C# Dev Kit and its now installed.
                // Offer a prompt to restart the server to use C# Dev Kit.
                _channel.appendLine(`Detected new installation of ${csharpDevkitExtensionId}`);
                let message = `Detected installation of ${csharpDevkitExtensionId}. Would you like to relaunch the language server for added features?`;
                ShowInformationMessage(vscode, message, { title, command });
            } else {
                // Any other change to extensions is irrelevant - an uninstall requires a reload of the window
                // which will automatically restart this extension too.
            }
        }));
    }

    private registerTelemtryChanged(languageClient: RoslynLanguageClientInstance) {
        // Subscribe to telemetry events so we can enable/disable as needed
        languageClient.addDisposable(vscode.env.onDidChangeTelemetryEnabled((isEnabled: boolean) => {
            const title = 'Restart Language Server';
            const command = 'dotnet.restartServer';
            const message = 'Detected change in telemetry settings. These will not take effect until the language server is restarted, would you like to restart?';
            ShowInformationMessage(vscode, message, { title, command });
        }));
    }

    private getServerFileName() {
        const serverFileName = 'Microsoft.CodeAnalysis.LanguageServer';
        let extension = '';
        if (this.platformInfo.isWindows()) {
            extension = '.exe';
        }

        if (this.platformInfo.isMacOS()) {
            // MacOS executables must be signed with codesign.  Currently all Roslyn server executables are built on windows
            // and therefore dotnet publish does not automatically sign them.
            // Tracking bug - https://devdiv.visualstudio.com/DevDiv/_workitems/edit/1767519/
            extension = '.dll';
        }

        return `${serverFileName}${extension}`;
    }

    private async getCSharpDevkitExportArgs(csharpDevkitExtension: vscode.Extension<CSharpDevKitExports>, options: Options) : Promise<string[]> {
        const exports: CSharpDevKitExports = await csharpDevkitExtension.activate();

        const extensionPaths = options.languageServerOptions.extensionsPaths || [this.getLanguageServicesDevKitComponentPath(exports)];

        let args: string[] = [];

        args.push("--sharedDependencies");
        args.push(exports.components['@microsoft/visualstudio-server-shared']);

        for (const extensionPath of extensionPaths) {
            args.push("--extension");
            args.push(extensionPath);
        }

        args.push("--sessionId", getSessionId());
        return args;
    }

    private async getCSharpDevkitIntelliCodeExportArgs(csharpDevkitIntelliCodeExtension: vscode.Extension<CSharpIntelliCodeExports>) : Promise<string[]> {
        const exports = await csharpDevkitIntelliCodeExtension.activate();

        const starredCompletionComponentPath = exports.components["@vsintellicode/starred-suggestions-csharp"];

        let csharpIntelliCodeArgs: string[] = [ "--starredCompletionComponentPath", starredCompletionComponentPath ];
        return csharpIntelliCodeArgs;
    }

    private getLanguageServicesDevKitComponentPath(csharpDevKitExports: CSharpDevKitExports) : string {
        return path.join(
            csharpDevKitExports.components["@microsoft/visualstudio-languageservices-devkit"],
            "Microsoft.VisualStudio.LanguageServices.DevKit.dll");
    }

    private GetTraceLevel(logLevel: string): Trace {
        switch (logLevel) {
            case "Trace":
                return Trace.Verbose;
            case "Debug":
                return Trace.Messages;
            case "Information":
                return Trace.Off;
            case "Warning":
                return Trace.Off;
            case "Error":
                return Trace.Off;
            case "Critical":
                return Trace.Off;
            case "None":
                return Trace.Off;
            default:
                _channel.appendLine(`Invalid log level ${logLevel}, server will not start. Please set the 'dotnet.server.trace' configuration to a valid value`);
                throw new Error(`Invalid log level ${logLevel}`);
        }
    }
}

/**
 * Brokered service implementation.
 */
export class SolutionSnapshotProvider implements ISolutionSnapshotProvider {
    public async registerSolutionSnapshot(token: vscode.CancellationToken): Promise<SolutionSnapshotId> {
        return _languageServer.registerSolutionSnapshot(token);
    }
}

export async function activateRoslynLanguageServer(context: vscode.ExtensionContext, platformInfo: PlatformInformation, optionProvider: OptionProvider, outputChannel: vscode.OutputChannel, reporter: TelemetryReporter) {

    // Create a channel for outputting general logs from the language server.
    _channel = outputChannel;
    // Create a separate channel for outputting trace logs - these are incredibly verbose and make other logs very difficult to see.
    _traceChannel = vscode.window.createOutputChannel("C# LSP Trace Logs");

    _languageServer = new RoslynLanguageServer(platformInfo, optionProvider, context, reporter);

    // Register any commands that need to be handled by the extension.
    registerCommands(context, _languageServer);

    // Register any needed debugger components that need to communicate with the language server.
    registerDebugger(context, _languageServer, platformInfo, optionProvider, _channel);    

    // Start the language server.
    _languageServer.start();
}

// this method is called when your extension is deactivated
export async function deactivate() {
    if (!_languageServer) {
        return undefined;
    }
    return _languageServer.stop();
}

// VS code will have a default session id when running under tests. Since we may still
// report telemetry, we need to give a unique session id instead of the default value.
function getSessionId(): string {
    let sessionId = vscode.env.sessionId;

    // 'somevalue.sessionid' is the test session id provided by vs code
    if (sessionId.toLowerCase() === 'somevalue.sessionid') {
        return randomUUID();
    }

    return sessionId;
}
