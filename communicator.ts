#!/usr/bin/env node
import * as io from "socket.io-client";
import {
    Control,
    ControlData,
    ControlUpdateData,
    DCDataModel,
    DCSerializableData,
    Endpoint,
    EndpointData,
    IDCDataRequest,
    IDCDataExchange,
    IndexedDataSet
} from "@devctrl/common";
import { IEndpointCommunicator,
        EndpointCommunicator,
        DummyCommunicator
} from "@devctrl/lib-communicator";
import {CommunicatorLoader} from "./CommunicatorLoader";
import { DCConfig } from "./config";
import * as fs from 'fs';




class DCCommunicator {
    io: SocketIOClient.Socket;
    endpoint: Endpoint;
    userInfo_id: string;
    oldEndpoint: Endpoint;
    dataModel: DCDataModel;
    controls: IndexedDataSet<Control>;
    config: DCConfig;
    communicator: IEndpointCommunicator;
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
                this.pushEndpointStatusUpdate();
            }
        });

        this.io.on('error', (obj) => {
            this.log(`websocket connection error: ${obj}`);
        });

        this.io.on('control-data', (data : IDCDataExchange) => {
            if (data.userInfo_id == this.userInfo_id) {
                this.log("ignoring broadcast of our data", EndpointCommunicator.LOG_DATA_MODEL);
                return;
            }

            this.loadData(data);
            this.checkData();
        });

        this.io.on('control-updates', data => {
            this.handleControlUpdates(data);
        });
    }

    checkData() {
        //this.log("checkData, endpoint enabled = " + this.endpoint.enabled, EndpointCommunicator.LOG_STATUS);

        if (! (this.communicator.epStatus === this.endpoint.epStatus)) {
            this.log("epStatus mismathc!!!", EndpointCommunicator.LOG_STATUS);
        }

        // Check endpoint for configuration changes
        if (this.oldEndpoint) {
            if (this.oldEndpoint.enabled != this.endpoint.enabled) {
                this.log("checkData, update enabled status", EndpointCommunicator.LOG_STATUS);
                this.communicator.updateStatus({enabled: this.endpoint.enabled});
            }
            else if (this.oldEndpoint.ip != this.endpoint.ip ||
                this.oldEndpoint.port != this.endpoint.port) {
                this.log("ip/port change. resetting communicator");
                this.communicator.reset();
            }
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
            _id: this.guid(),
            table: Control.tableStr,
            params: {
                endpoint_id: this.endpoint._id
            }
        };

        this.getData(reqData, this.launchCommunicator);
    }

    private addData(reqData: {[index:string] : DCSerializableData[]}, then: () => void) {
        this.io.emit('add-data',
            {
                _id: this.guid(),
                userInfo_id: this.userInfo_id,
                add: reqData
            },
            data => {
                if ( data.error ) {
                    this.log("add-data error: " + data.error);
                }
                else {
                    this.loadData(data);
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
                this.loadData(data);
            }

            then.call(this);  // If the callback doesn't belong to this class, this could get weird
        });
    }


    getEndpointConfig() {
        this.endpoint = this.dataModel.getItem(this.config.endpointId, Endpoint.tableStr) as Endpoint;

        let reqData = this.endpoint.itemRequestData(this.guid());

        this.getData(reqData, this.getEndpointTypeConfig);
    }

    getEndpointTypeConfig() {
        if (! this.endpoint.dataLoaded) {
            this.log("endpoint data is missing");
            return;
        }

        //
        this.endpoint.epStatus.messengerConnected = true;

        this.getData(this.endpoint.type.itemRequestData(this.guid()), this.getControls);
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
            if (this.config.dummyCommunicator) {
                this.communicator = new DummyCommunicator({
                    endpoint: this.endpoint,
                    controlUpdateCallback: (control, value) => {
                        this.pushControlUpdate(control, value);
                    },
                    statusUpdateCallback: () => {
                        this.pushEndpointStatusUpdate();
                    }
                });
            }
            else {
                let commType = this.endpoint.type.communicatorClass;
                let cl = new CommunicatorLoader();

                let commClass = cl.communicators[commType];

                if (!commClass) {
                    throw new Error("communicator class not found: " + commType);
                }

                this.log(`instantiating communicator ${commType}`);
                this.communicator = new commClass({
                    endpoint: this.endpoint,
                    controlUpdateCallback: (control, value) => {
                        this.pushControlUpdate(control, value);
                    },
                    statusUpdateCallback: () => {
                        this.pushEndpointStatusUpdate();
                    }
                });
            }

            if (typeof this.communicator.run !== 'function') {
                this.log("it doesn't look like you have a valid communicator class");
            }
        }

        this.syncControls();
    }

    loadData(data: IDCDataExchange) {

        // Discard control data not related to this endpoint
        if (data.add && data.add.controls) {
            let deleteIds = [];
            for (let id in data.add.controls) {
                if ((<ControlData>data.add.controls[id]).endpoint_id !== this.endpoint._id) {
                    deleteIds.push(id);
                }
            }

            for (let id of deleteIds) {
                delete data.add.controls[id];
            }
        }

        // EndpointStatus is an object, this process is the authoritative source for many of its properties.
        // Preserve the object reference and update fields accordingly.
        if (this.endpoint.dataLoaded && data.add && data.add.endpoints && data.add.endpoints[this.config.endpointId]) {
            this.oldEndpoint = new Endpoint(this.endpoint._id, <EndpointData>(this.endpoint.getDataObject()));

            let epUpdate = <EndpointData>data.add.endpoints[this.config.endpointId];
            // Defer to server for enabled
            this.endpoint.epStatus.enabled = epUpdate.epStatus.enabled;

            // Preserve the current epStatus object.  loadData will overwrite it otherwise
            epUpdate.epStatus = this.endpoint.epStatus;
        }

        if (this.communicator) {
            if (!(this.communicator.epStatus === this.endpoint.epStatus)) {
                this.log("epStatus mismatch!!!", EndpointCommunicator.LOG_STATUS);
            }
        }

        this.dataModel.loadData(data);
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

        this.log(`pushing ${update.name}: ${update.value}`, EndpointCommunicator.LOG_UPDATES);
        this.io.emit('control-updates', [update]);
    }

    pushEndpointStatusUpdate() {
        let update : IDCDataExchange = {
            _id: this.guid(),
            userInfo_id: this.userInfo_id,
            add: { endpoints: {}}
        };
        update.add.endpoints[this.endpoint._id] = this.endpoint.getDataObject();

        let statusStr = this.endpoint.statusStr;
        this.log("sending status update: " + statusStr, EndpointCommunicator.LOG_STATUS);
        this.updateData(update, () => {});
    }

    registerEndpoint() {
        //TODO: multiple register messages are being sent on reconnect
        this.io.emit('register-endpoint', { endpoint_id : this.config.endpointId}, (data) => {
            if (data.userInfo_id) {
                this.userInfo_id = data.userInfo_id;
                this.log("userInfo_id set to " + this.userInfo_id, EndpointCommunicator.LOG_CONNECTION);
            }
        });
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
        this.communicator.run();
    }


    private updateData(reqData: IDCDataExchange, then: () => void ) {
        this.io.emit('update-data', reqData, data => {
            if ( data.error ) {
                this.log("update-data error: " + data.error);
            }
            else {
                this.loadData(data);
            }

            then.call(this);  // If the callback doesn't belong to this class, this could get weird
        });
    }

}

let configName = "dcc";
if (typeof process.argv[2] !== 'undefined') {
    console.log("arg 2 is " + process.argv[2]);
    configName = process.argv[2];
}

//TODO: use __dirname to construct path to package.json
if (fs.existsSync("package.json")) {
    let pkgJson = fs.readFileSync("package.json", 'utf8');
    let pkgObj = JSON.parse(pkgJson);

    console.log(`Devctrl Communicator version ${pkgObj.version} launched`);
}


let config = new DCConfig(configName);
let dcc = new DCCommunicator();
dcc.run(config);

