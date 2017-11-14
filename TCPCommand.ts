
import {
    ControlUpdate,
    ControlUpdateData,
    Control,
    ControlData
} from "@devctrl/common";
import {sprintf} from "sprintf-js";

let debug = console.log;

export interface ITCPCommandConfig {
    cmdStr: string;
    cmdQueryStr?: string; // The query string to send to have this value reported
    cmdQueryResponseRE?: string | RegExp; // RE to match the response to a device poll
    cmdUpdateTemplate?: string; // Send this string to change a setting
    cmdUpdateResponseTemplate?: string; // What the device sends to report a change
    cmdReportRE?: string | RegExp;  // How the device reports a change to this command
    cmdReportREMatchIdx?: number; // cmdReport RegEx is processed with match. Value is at this location in matches[]
    endpoint_id: string;
    control_type: string;
    usertype: string;
    templateConfig: any;
    poll?: number;
    ephemeral?: boolean;
    readonly?: boolean; // Don't bother trying to set this value
    writeonly?: boolean; // Don't bother trying to read this value
}




export class TCPCommand {
    cmdStr: string;
    cmdQueryStr: string; // The query string to send to have this value reported
    cmdQueryResponseRE: RegExp = /^$a/; // RE to match the response to a device poll, default matches nothing
    cmdUpdateTemplate: string; // Send this string to change a setting
    cmdUpdateResponseTemplate: string; // What the device reports after an update
    cmdReportRE: RegExp = /^$a/; // How the device reports an external change to this command. default matches nothing
    cmdReportREMatchIdx: number;
    name: string;
    endpoint_id: string;
    usertype: string;
    control_type: string;
    templateConfig: any;
    ctidList: string[];
    poll: number = 0;
    ephemeral: boolean; // Command value will not be persisted in the database
    readonly: boolean; // Command value cannot be sent to device.  Defaults to false
    writeonly: boolean;  // Command value cannot be read from device. Defaults to false


    constructor(config: ITCPCommandConfig) {
        this.cmdStr = config.cmdStr;
        this.name = config.cmdStr;
        this.endpoint_id = config.endpoint_id;
        this.usertype = config.usertype;
        this.control_type = config.control_type;
        this.templateConfig = config.templateConfig;

        if (config.poll) {
            this.poll = config.poll;
        }
        this.ephemeral = !!config.ephemeral;

        this.cmdQueryStr = config.cmdQueryStr ? config.cmdQueryStr : '';
        this.cmdUpdateTemplate = config.cmdUpdateTemplate ? config.cmdUpdateTemplate : '';
        this.cmdUpdateResponseTemplate = config.cmdUpdateResponseTemplate ? config.cmdUpdateResponseTemplate : '';
        this.cmdReportREMatchIdx = config.cmdReportREMatchIdx ? config.cmdReportREMatchIdx : 1;
        
        if (config.cmdQueryResponseRE) {
            if (typeof config.cmdQueryResponseRE == "string") {
                this.cmdQueryResponseRE = new RegExp(<string>config.cmdQueryResponseRE);
            }
            else {
                this.cmdQueryResponseRE = <RegExp>config.cmdQueryResponseRE;
            }
        }

        if (config.cmdReportRE) {
            if (typeof config.cmdReportRE == "string") {
                this.cmdReportRE = new RegExp(<string>config.cmdReportRE);
            }
            else {
                this.cmdReportRE = <RegExp>config.cmdReportRE;
            }
        }

        this.readonly = !!config.readonly;
        this.writeonly = !!config.writeonly;
    }

    expandTemplate(template: string, value: any) : string {
        // Use sprintf to expand the template
        let res = '';

        if (this.control_type == Control.CONTROL_TYPE_BOOLEAN) {
            //sprintf does nothing useful with boolean values, use 1 and 0 instead
            value = value ? 1 : 0;
        }

        try {
            res = sprintf(template, value);
        }
        catch(e) {
            debug("Error expanding template " + template);
            debug(e.message);
        }

        return res;
    }

    getControlTemplates() : Control[] {
        let ctid = this.endpoint_id + "-" + this.cmdStr;
        let templateData : ControlData = {
            _id: ctid,
            ctid: ctid,
            endpoint_id: this.endpoint_id,
            usertype: this.usertype,
            name: this.name,
            control_type: this.control_type,
            poll: this.poll,
            ephemeral: this.ephemeral,
            config: this.templateConfig,
            value: 0
        };
        let templates = [ new Control(ctid, templateData)];
        this.ctidList = [ctid];

        return templates;
    }


    matchesReport(devStr: string) : boolean {
        if (! this.cmdReportRE) {
            return devStr == this.cmdStr;
        }

        let matches = devStr.match(this.cmdReportRE);

        return !!matches;
    }

    // Override this function in a custom Command class if necessary
    parseBoolean(value) : boolean {
        // Add string representations of 0 and false to standard list of falsey values
        if (typeof value == "string") {
            if (value.toLowerCase() == "false") {
                return false;
            }
            if (parseInt(value) == 0) {
                return false;
            }
        }

        return !!value;
    }

    parseReportValue(control: Control, line: string) : any {
        if (! this.cmdReportRE) {
            return line;
        }

        let matches = line.match(this.cmdReportRE);

        if (matches && matches.length > 1) {
            return this.parseValue(matches[this.cmdReportREMatchIdx]);
        }

        return '';
    }

    parseQueryResponse(control: Control, line: string) : any {
        let matches = line.match(this.queryResponseMatchString());

        if (matches) {
            return this.parseValue(matches[1]);
        }

        return '';
    }

    parseValue(value) : any {
        if (this.control_type == Control.CONTROL_TYPE_RANGE) {
            return parseFloat(value);
        }
        else if (this.control_type == Control.CONTROL_TYPE_INT) {
            return parseInt(value);
        }
        else if (this.control_type == Control.CONTROL_TYPE_BOOLEAN) {
            return this.parseBoolean(value);
        }

        return value;
    }


    queryString() : string {
        if (this.cmdQueryStr) {
            return this.cmdQueryStr;
        }

        return `${this.cmdStr}?`;
    }

    queryResponseMatchString() : string | RegExp {
        return this.cmdQueryResponseRE;
    }

    updateString(control: Control, update: ControlUpdateData) {
        if (this.cmdUpdateTemplate) {
            return this.expandTemplate(this.cmdUpdateTemplate, update.value);
        }

        return `${ this.cmdStr } ${ update.value }`;
    }

    updateResponseMatchString(update: ControlUpdateData) : string {
        if (this.cmdUpdateResponseTemplate) {
            return this.expandTemplate(this.cmdUpdateResponseTemplate, update.value);
        }

        return update.value;
    }



}