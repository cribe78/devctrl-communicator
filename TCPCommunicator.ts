import {EndpointCommunicator, IEndpointCommunicatorConfig} from "./EndpointCommunicator";
import { TCPCommand } from "./TCPCommand";
import * as net from "net";
import {Control} from "../app/shared/Control";
import {ControlUpdateData} from "../app/shared/ControlUpdate";
import {EndpointStatus} from "../app/shared/Endpoint";
import {IndexedDataSet} from "../app/shared/DCDataModel";

export type TCPCommEncoding = "string" | "hex";

//TODO: convert expectedResponse from an array to a proper object

export class TCPCommunicator extends EndpointCommunicator {
    host: string;
    port : number;
    socket: net.Socket;
    commands: IndexedDataSet<TCPCommand> = {};
    commandsByTemplate: IndexedDataSet<TCPCommand> = {};
    inputLineTerminator : string | RegExp = '\r\n';
    outputLineTerminator = '\r\n';
    socketEncoding = 'utf8';
    inputBuffer: string = '';
    pollTimer: any = 0;
    backoffTime: number = 1000;
    expectedResponses: [string | RegExp, (line: string) => any][] = [];
    commsMode : TCPCommEncoding = "string";



    constructor() {
        super();
    }

    buildCommandList() {

    }

    connect() {
        let self = this;

        this.host = this.config.endpoint.ip;
        this.port = this.config.endpoint.port;

        let connectOpts = {
            port: this.config.endpoint.port,
            host: this.config.endpoint.ip
        };


        this.socket = net.connect(connectOpts, function() {
            self.log("connected to " + connectOpts.host + ":" + connectOpts.port, EndpointCommunicator.LOG_CONNECTION);

            self.doDeviceLogon();
        });

        this.socket.on('error', function(e) {
            self.log("caught socket error: " + e.message, EndpointCommunicator.LOG_CONNECTION);
            self.onEnd();
        });

        this.socket.on('data', function(data) {
            self.onData(data);
        });
        this.socket.on('end', function() {
            self.onEnd();
        });

        if (! this.pollTimer) {
            this.pollTimer = setInterval(function () {
                self.poll();
            }, 10000);
        }
    }

    connectionConfirmed() {
        this.backoffTime = 1000;
    }

    disconnect() {
        this.socket.end();
        this.connected = false;
        this.config.statusUpdateCallback(EndpointStatus.Offline);
    }

    doDeviceLogon() {
        this.connected = true;
        this.config.statusUpdateCallback(EndpointStatus.Online);
        this.online();
    };

    executeCommandQuery(cmd: TCPCommand) {
        if (! cmd.queryString()) {
            return;
        }

        let self = this;
        let queryStr = cmd.queryString();
        this.log("sending query: " + queryStr, EndpointCommunicator.LOG_POLLING);
        this.writeToSocket(queryStr + this.outputLineTerminator);

        this.expectedResponses.push([
            cmd.queryResponseMatchString(),
            (line) => {
                for (let ctid of cmd.ctidList) {
                    let control = self.controlsByCtid[ctid];
                    //debug("control id is " + control._id);
                    let val = cmd.parseQueryResponse(control, line);
                    self.setControlValue(control, val);
                }

                self.connectionConfirmed();
            }
        ]);
    }

    getControlTemplates() : IndexedDataSet<Control> {
        this.buildCommandList();

        for (let cmd in this.commands) {
            let templateList = this.commands[cmd].getControlTemplates();

            for (let tpl of templateList) {
                // Don't mess with this.controls.  That belongs to the data model
                //this.controls[tpl._id] = tpl;
                this.controlsByCtid[tpl.ctid] = tpl;
                this.commandsByTemplate[tpl.ctid] = this.commands[cmd];
            }
        }

        return this.controlsByCtid;
    }

    handleControlUpdateRequest(request: ControlUpdateData) {
        let control = this.controls[request.control_id];

        if (! this.connected) {
            return;
        }

        let command = this.commandsByTemplate[control.ctid];

        if (command) {
            let updateStr = command.updateString(control, request);
            this.log("sending update: " + updateStr, EndpointCommunicator.LOG_UPDATES);

            this.queueCommand(updateStr + this.outputLineTerminator,
                [
                    command.updateResponseMatchString(request),
                    (line) => {
                        this.setControlValue(control, request.value);
                    }
                ]
            );

            // Mark this control as indeterminate, in case we see a query or other update
            // regarding it but the expected response never comes
            this.indeterminateControls[request.control_id] = true;
        }
    }


    matchLineToCommand(line: string) : TCPCommand | boolean {
        for (let cmdStr in this.commands) {
            let cmd = this.commands[cmdStr];

            if (cmd.matchesReport(line)) {
                this.log("read: " + line + ", matches cmd " + cmd.name, EndpointCommunicator.LOG_MATCHING);
                return cmd;
            }
        }

        return false;
    }

    matchLineToError(line: string) : boolean {

        return false;
    }

    matchLineToExpectedResponse(line: string) : boolean {
        for (let idx = 0; idx < this.expectedResponses.length; idx++) {
            let eresp = this.expectedResponses[idx];

            if (line.search(<string>eresp[0]) > -1 ) {
                this.log(`${line} matched expected response "${eresp[0]}" at [${idx}]`, EndpointCommunicator.LOG_MATCHING);
                //Execute expected response callback
                eresp[1](line);

                this.expectedResponses = this.expectedResponses.slice(idx + 1);
                return true;
            }
        }

        return false;
    }

    onData(data: any) {
        let strData = '';
        if (this.commsMode == 'string') {
            strData = String(data);
        }
        else if (this.commsMode == 'hex') {
            strData = data.toString('hex');
        }

        this.inputBuffer += strData;
        let lines = this.inputBuffer.split(this.inputLineTerminator);

        while (lines.length > 1) {
            this.log("data recieved: " + lines[0], EndpointCommunicator.LOG_RAW_DATA);
            this.processLine(lines[0]);

            lines.splice(0,1);
        }

        this.inputBuffer = lines[0];
    }

    onEnd() {
        let self = this;
        if (this.config.endpoint.enabled) {
            this.log("device disconnected " + this.host + ", reconnect in " + this.backoffTime + "ms", "connection");
            this.connected = false;

            this.config.statusUpdateCallback(EndpointStatus.Offline);

            if (! this.socket["destroyed"]) {  // socket.destroyed is missing from Typings file
                this.log("destroying socket", EndpointCommunicator.LOG_CONNECTION);
                this.socket.destroy();
            }

            setTimeout(function () {
                self.connect();
            }, this.backoffTime);

            if (this.backoffTime < 20000) {
                this.backoffTime = this.backoffTime * 2;
            }
        }
        else {
            this.log("successfully disconnected from " + this.host, EndpointCommunicator.LOG_CONNECTION);
        }
    }

    /**
     *  Functions to perform when device connection has been confirmed
     */
    online() {
        this.queryAll();
    }

    poll() {
        if (! this.connected) {
            return;
        }

        let exd = this.expectedResponses.length;
        if (exd > 1000) {
            this.log(`WARNING polling device, expected response queue has reached length of ${exd}`);
        }

        for (let id in this.controls) {
            let control = this.controls[id];

            if (control.poll) {
                let cmd = this.commandsByTemplate[control.ctid];

                if (cmd) {
                    this.executeCommandQuery(cmd);
                }
                else {
                    this.log("command not found for poll control " + control.ctid);
                }
            }
        }
    }


    preprocessLine(line: string) : string {
        return line;
    }

    processLine(line: string) {
        line = this.preprocessLine(line);

        //Ignore empty lines
        if (line == '') return;

        if (this.matchLineToError(line)) {
            return;
        }

        // Check line against expected responses
        if (this.matchLineToExpectedResponse(line)) {
            return;
        }

        // Match line to a command
        let match = this.matchLineToCommand(line);


        if (match) {
            let cmd = <TCPCommand>match;
            for (let ctid of cmd.ctidList) {
                let control = this.controlsByCtid[ctid];

                let val = cmd.parseReportValue(control, line);
                this.setControlValue(control, val);
            }

            this.connectionConfirmed();

        }
        else {
            this.log("read, unmatched: " + line, EndpointCommunicator.LOG_MATCHING);
        }
    }

    /**
     * This implementation just writes the command to the socket.  Child classes
     * can do fancier things
     */

    queueCommand(cmdStr : string, expectedResponse: [string | RegExp, (line: string) => any]) {
        this.writeToSocket(cmdStr);

        if (expectedResponse[0] == '') {
            // Get on with it
            expectedResponse[1]('');
        }
        else {
            this.expectedResponses.push(expectedResponse);
        }
    }

    /**
     * Query all controls, regardless of poll setting.
     *
     * Override this method to exclude polling of certain controls
     */

    queryAll() {
        for (let cmdStr in this.commands) {
            if (! this.commands[cmdStr].writeonly) {
                this.executeCommandQuery(this.commands[cmdStr]);
            }
        }
    }




    writeToSocket(val: string) {
        let bufMode = 'ascii';
        if (this.commsMode == 'hex') {
            val = val.replace(/[\s:]/g, '');  // Allow definitions of hex strings to include byte delimeters
            bufMode = 'hex';
        }

        this.log(`sending data: ${val}`, EndpointCommunicator.LOG_RAW_DATA);
        let bufferToSend = Buffer.from(val, bufMode);
        this.socket.write(bufferToSend);
    }
}