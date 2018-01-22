#!/usr/bin/env node
import * as io from "socket.io-client";
import {
    Control,
    ControlUpdateData,
    DCDataModel,
    Endpoint,
    EndpointData,
    EndpointStatus,
    IDCDataRequest,
    IDCDataUpdate,
    IndexedDataSet
} from "@devctrl/common";
import { EndpointCommunicator } from "@devctrl/lib-communicator";
import {CommunicatorLoader} from "./CommunicatorLoader";
import { DCConfig } from "./config";


class NControl {
    io: SocketIOClient.Socket;
    endpoint: Endpoint;
    oldEndpoint: Endpoint;
    dataModel: DCDataModel;
    controls: IndexedDataSet<Control>;
    config: DCConfig;
    communicator: EndpointCommunicator;
    syncControlsPassNumber: number = 0;


    constructor() {
        this.dataModel = new DCDataModel();
        this.dataModel.debug = (msg) => {
            this.log(msg, EndpointCommunicator.LOG_DATA_MODEL);
        };

        this.controls = this.dataModel.tables[Control.tableStr] as IndexedDataSet<Control>;
    }

    run(config: DCConfig) {
        this.config = <DCConfig>config;
        this.log(`connecting to ${config.wsUrl}${config.ioPath}`);
        let connectOpts = {
            transports: ['websocket'],
            path : config.ioPath
        };

        connectOpts['extraHeaders'] = { 'ncontrol-auth-id' : config.authId }

        this.io = io.connect(config.wsUrl, connectOpts);

        this.io.on('connect', () => {
            this.log("websocket client connected");

            //Get endpoint data
            this.getEndpointConfig();
            this.registerEndpoint();
        });

        this.io.on('connect_error', (err) => {
            this.log(`io connection error: ${err}`);
        });

        this.io.on('reconnect', () => {
            this.registerEndpoint();
            if (this.endpoint) {
                this.pushEndpointStatusUpdate(this.endpoint.status);
            }
        });

        this.io.on('error', (obj) => {
            this.log(`websocket connection error: ${obj}`);
        });

        this.io.on('control-data', data => {
            this.oldEndpoint = new Endpoint(this.endpoint._id, <EndpointData>(this.endpoint.getDataObject()));

            // Discard control data not related to this endpoint
            if (data.add && data.add.controls) {
                let deleteIds = [];
                for (let id in data.add.controls) {
                    if (data.add.controls[id].endpoint_id !== this.endpoint._id) {
                        deleteIds.push(id);
                    }
                }

                for (let id of deleteIds) {
                    delete data.add.controls[id];
                }
            }

            this.dataModel.loadData(data);
            this.checkData();
        });

        this.io.on('control-updates', data => {
            this.handleControlUpdates(data);
        });
    }

    checkData() {
        // Check endpoint for configuration changes
        if (this.oldEndpoint.enabled != this.endpoint.enabled) {
            if (this.endpoint.enabled) {
                this.log("Endpoint enabled. Connecting");
                this.communicator.connect();
            }
            else {
                this.log("Endpoint disabled.  Disconnecting");
                this.communicator.disconnect();
            }
        }
        else if (this.oldEndpoint.ip != this.endpoint.ip ||
                this.oldEndpoint.port != this.endpoint.port ) {
            this.log("ip/port change. resetting communicator");
            this.communicator.disconnect();
            this.communicator.connect();
        }
    }

    log(msg : string, tag = "default") {
        if (this.communicator) {
            this.communicator.log(msg, tag);
        }
        else {
            console.log(msg);
        }
    }

    getControls() {
        let reqData = {
            table: Control.tableStr,
            params: {
                endpoint_id: this.endpoint._id
            }
        };

        this.getData(reqData, this.launchCommunicator);
    }

    private addData(reqData: any, then: () => void) {
        this.io.emit('add-data', reqData, data => {
            if ( data.error ) {
                this.log("add-data error: " + data.error);
            }
            else {
                this.dataModel.loadData(data);
            }

            then.call(this);  // If the callback doesn't belong to this class, this could get weird
        });
    }

    private getData(reqData: IDCDataRequest, then: () => void ) {
        this.io.emit('get-data', reqData, data => {
            if ( data.error ) {
                this.log("get-data error: " + data.error);
            }
            else {
                this.dataModel.loadData(data);
            }

            then.call(this);  // If the callback doesn't belong to this class, this could get weird
        });
    }

    private updateData(reqData: IDCDataUpdate, then: () => void ) {
        this.io.emit('update-data', reqData, data => {
            if ( data.error ) {
                this.log("update-data error: " + data.error);
            }
            else {
                this.dataModel.loadData(data);
            }

            then.call(this);  // If the callback doesn't belong to this class, this could get weird
        });
    }



    getEndpointConfig() {
        this.endpoint = this.dataModel.getItem(this.config.endpointId, Endpoint.tableStr) as Endpoint;

        let reqData = this.endpoint.itemRequestData();

        this.getData(reqData, this.getEndpointTypeConfig);
    }

    getEndpointTypeConfig() {
        if (! this.endpoint.dataLoaded) {
            this.log("endpoint data is missing");
            return;
        }

        this.getData(this.endpoint.type.itemRequestData(), this.getControls);
    }

    guid() : string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            let r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
            return v.toString(16);
        });
    }

    handleControlUpdates(data: ControlUpdateData[]) {
        for (let update of data) {
            let control = this.dataModel.getItem(update.control_id, Control.tableStr) as Control;

            if (control.endpoint_id && control.endpoint_id == this.endpoint._id
            && update.status == "requested") {
                this.log(`control update: ${ control.name } : ${ update.value }`);

                if (control.control_type == Control.CONTROL_TYPE_ECHO) {
                    // Just update the value and kick it back to the messenger
                    // This is a "dummy" command that can be used to trigger other
                    // actions

                    this.pushControlUpdate(control, update.value);
                    return;
                }

                this.communicator.handleControlUpdateRequest(update);
            }
        }
    }

    launchCommunicator() {
        if (! this.endpoint.type.dataLoaded) {
            this.log("endpointType data is missing");
        }

        if (! this.communicator) {
            let commType = this.endpoint.type.communicatorClass;
            let cl = new CommunicatorLoader();

            let commClass = cl.communicators[commType];

            if (! commClass) {
                throw new Error("communicator class not found: " + commType);
            }

            this.log(`instantiating communicator ${commType}`);
            this.communicator = new commClass();

            if (typeof this.communicator.setConfig !== 'function') {
                this.log("it doesn't look like you have a valid communicator class");
            }

            this.communicator.setConfig({
                endpoint: this.endpoint,
                controlUpdateCallback: (control, value) => {
                    this.pushControlUpdate(control, value);
                },
                statusUpdateCallback: (status) => {
                    this.pushEndpointStatusUpdate(status);
                }
            });
        }

        this.syncControls();

        if (this.endpoint.enabled) {
            if (! this.communicator.connected) {
                this.communicator.connect();
            }
            else {
                this.log("communicator already connected");
            }
        }
        else {
            this.log("endpoint not enabled, not connecting");
        }
    }

    pushControlUpdate(control: Control, value: any) {
        let update : ControlUpdateData = {
            _id : this.guid(),
            name: control.name + " update",
            control_id: control._id,
            value: value,
            type: "device",
            status: "observed",
            source: this.endpoint._id,
            ephemeral: control.ephemeral
        };

        this.io.emit('control-updates', [update]);
    }

    pushEndpointStatusUpdate(status: EndpointStatus) {
        this.endpoint.status = status;
        let update : IDCDataUpdate = {
            table: Endpoint.tableStr,
            _id: this.endpoint._id,
            "set" : { status: status }
        };

        this.updateData(update, () => {});
    }

    registerEndpoint() {
        //TODO: multiple register messages are being sent on reconnect
        this.io.emit('register-endpoint', { endpoint_id : this.config.endpointId});
    }

    syncControls() {
        this.syncControlsPassNumber++;

        if (this.syncControlsPassNumber > 2) {
            throw new Error("failed to sync control templates");
        }

        // Don't do this part twice
        if (this.syncControlsPassNumber == 1) {
            // Get ControlTemplates from communicator
            let controlTemplates = this.communicator.getControlTemplates();

            let newControls = [];
            let controlsByCtid = {};

            for (let id in this.controls) {
                let ct = this.controls[id];
                controlsByCtid[ct.ctid] = ct;
            }

            // Match communicator control templates to server control templates by ctid
            for (let ctid in controlTemplates) {
                if (! controlsByCtid[ctid]) {
                    newControls.push(controlTemplates[ctid].getDataObject());
                }
            }

            // newControls is an array of templates to create
            // Create new ControlTemplates on server
            if (newControls.length > 0) {
                this.log("adding new controls");
                this.addData({ controls: newControls}, this.syncControls);

                return;
            }
        }

        this.log("controls successfully synced!");

        // Pass completed ControlTemplate set to communicator
        this.communicator.setTemplates(<IndexedDataSet<Control>>this.dataModel.tables[Control.tableStr]);
    }

}

let configName = "dcc";
if (typeof process.argv[2] !== 'undefined') {
    console.log("arg 2 is " + process.argv[2]);
    configName = process.argv[2];
}


let config = new DCConfig(configName);
let dcc = new NControl();
dcc.run(config);

