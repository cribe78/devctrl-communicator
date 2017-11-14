import {
    Control,
    ControlUpdateData,
    EndpointStatus,
    IndexedDataSet
} from "@devctrl/common";
import {EndpointCommunicator} from "./EndpointCommunicator";
import {HTTPCommand} from "./HTTPCommand";
import * as http from "http";

export class HTTPCommunicator extends EndpointCommunicator {
    commands: IndexedDataSet<HTTPCommand> = {};
    commandsByControl: IndexedDataSet<HTTPCommand> = {};
    pollTimer;

    constructor() {
        super();
    }

    buildCommandList() : void {}

    connect() {
        this._connected = true;
        this.config.statusUpdateCallback(EndpointStatus.Online);

        if (! this.pollTimer) {
            this.pollTimer = setInterval(() => {
                this.poll();
            }, 10000);
        }
    };

    disconnect() {
        this._connected = false;
        this.config.statusUpdateCallback(EndpointStatus.Offline);
    };

    executeCommandQuery(cmd: HTTPCommand) {
        if (cmd.writeonly) {
            this.log(`not querying writeonly command ${cmd.name}`, EndpointCommunicator.LOG_POLLING);
        }


        let control = this.controlsByCtid[cmd.controlData.ctid];
        let requestOptions = {
            hostname: this.config.endpoint.address,
            path: cmd.queryPath()
        };

        let requestPath = "http://" + requestOptions.hostname + requestOptions.path;
        this.log("sending request:" + requestPath, EndpointCommunicator.LOG_RAW_DATA);

        http.get(requestPath, (res) => {
            if (res.statusCode !== 200) {
                this.log("invalid status code response: " + res.statusCode);
            }
            else {
                //debug(`cmd ${cmd.name} successfully queried`);
                res.setEncoding('utf8');
                let body ='';
                res.on('data', (chunk) => { body += chunk});
                res.on('end', () => {
                    let val = cmd.parseQueryResponse(body);
                    if (typeof val !== 'undefined') {
                        this.log(`${cmd.name} response parsed: ${body},${val}`, EndpointCommunicator.LOG_POLLING);
                        this.config.controlUpdateCallback(control, val);
                    }
                    else {
                        this.log(`${cmd.name} update response did not match: ${body}`, EndpointCommunicator.LOG_MATCHING);
                    }
                });
            }
        })
            .on('error', (e) => {
                this.log(`Error on query: ${e.message}`);
                this.disconnect();
            });
    }

    getControlTemplates() : IndexedDataSet<Control> {
        this.buildCommandList();

        for (let cmd in this.commands) {
            let controls = this.commands[cmd].getControls();

            for (let control of controls) {
                this.controlsByCtid[control.ctid] = control;
                this.commandsByControl[control.ctid] = this.commands[cmd];
            }
        }

        return this.controlsByCtid;
    }

    /**
     * Process a ControlUpdate, likely by sending a command to
     * a device
     * @param update ControlUpdateData The request control update
     */
    handleControlUpdateRequest(update: ControlUpdateData) {
        let control = this.controls[update.control_id];
        let command = this.commands[control.ctid];

        if (! command) {
            this.log(`No command found for control ${control.name}`);
            return;
        }

        let requestOptions = {
            hostname: this.config.endpoint.address,
            path: command.commandPath(update.value)
        };

        let requestPath = "http://" + requestOptions.hostname + requestOptions.path;
        this.log("sending request:" + requestPath, EndpointCommunicator.LOG_RAW_DATA);

        http.get(requestPath, (res) => {
            if (res.statusCode !== 200) {
                this.log("invalid status code response: " + res.statusCode);
            }
            else {
                //debug(`${command.name} set to ${update.value} successfully`);
                res.setEncoding('utf8');
                let body ='';
                res.on('data', (chunk) => { body += chunk});
                res.on('end', () => {
                    if (command.matchResponse(body)) {
                        let newVal = command.parseCommandResponse(body, update.value);
                        this.log(`${control.name} response successful, value: ${newVal}`, EndpointCommunicator.LOG_UPDATES);
                        this.config.controlUpdateCallback(control, newVal);
                    }
                    else {
                        this.log(`${control.name} update response did not match: ${body}`, EndpointCommunicator.LOG_MATCHING);
                    }
                });
            }
        }).on('error', (e) => {
            this.log(`Error on update request: ${e.message}`);
            this.disconnect();
        });
    }

    poll() {
        if (! this.connected) {
            return;
        }

        this.log("polling device", EndpointCommunicator.LOG_POLLING);

        for (let id in this.controls) {
            let control = this.controls[id];

            if (control.poll) {
                let cmd = this.commandsByControl[control.ctid];

                if (cmd) {
                    this.executeCommandQuery(cmd);
                }
                else {
                    this.log("command not found for poll control " + control.ctid);
                }
            }
        }
    }
}
