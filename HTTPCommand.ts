import {ControlData, Control} from "@devctrl/common";
import {sprintf} from "sprintf-js";
let debug = console.log;

export interface IHTTPCommandConfig {
    name: string;
    cmdPathFunction? : (value: any)=>string;
    cmdPathTemplate? : string; // A function returning the path or a template to expand
    cmdResponseRE : string;  //
    cmdResponseParser?: (value: string) => any;  // An optional function to extract a value from a response
    cmdQueryPath: string;
    cmdQueryResponseParseFn: (value: string) => any;
    controlData: ControlData;
    readonly?: boolean;
    writeonly?: boolean;
}


export class HTTPCommand {
    name: string;
    cmdPathFunction : (value: any)=>string;
    cmdPathTemplate : string; // A function returning the path or a template to expand
    cmdResponseRE : RegExp;  //
    cmdResponseParser: (value: string) => any;
    cmdQueryPath : string;
    cmdQueryResponseParseFn: (value: string) => any;
    controlData: ControlData;
    readonly: boolean;
    writeonly: boolean;

    constructor(config: IHTTPCommandConfig) {
        this.name = config.name;
        this.cmdPathFunction = config.cmdPathFunction;
        this.cmdPathTemplate = config.cmdPathTemplate;
        this.cmdResponseRE = new RegExp(config.cmdResponseRE);
        this.cmdResponseParser = config.cmdResponseParser;
        this.cmdQueryPath = config.cmdQueryPath;
        this.cmdQueryResponseParseFn = config.cmdQueryResponseParseFn;
        this.controlData = config.controlData;

        this.readonly = !! config.readonly;
        this.writeonly = !! config.writeonly;
    }

    commandPath(value : any) : string {
        let path = `/${value}`;   //  Fairly useless default value
        if (this.cmdPathFunction) {
            path = this.cmdPathFunction(value);
        }
        else if (typeof this.cmdPathTemplate !== 'undefined') {
            if (this.controlData.control_type == Control.CONTROL_TYPE_BOOLEAN) {
                value = value ? 1 : 0;
            }

            path = sprintf(this.cmdPathTemplate, value);
        }

        return path;
    }


    getControls() : Control[] {
        return [ new Control(this.controlData._id, this.controlData)];
    }

    matchResponse(resp : string) {
        let matches = resp.match(this.cmdResponseRE);
        if (matches) {
            return true;
        }
        return false;
    }


    parseCommandResponse(resp, defaultValue) : any {
        if (typeof this.cmdResponseParser !== 'function') {
            return defaultValue;
        }

        let ret = this.cmdResponseParser(resp);
        //debug(`HTTPCommand parsed value: ${ret}`);
        return ret;
    }

    parseQueryResponse(resp) : any {
        let val;
        if (typeof this.cmdQueryResponseParseFn == 'function') {
            val = this.cmdQueryResponseParseFn(resp);
        }
        return val;
    }

    parseValue(value) : any {
        if (this.controlData.control_type == Control.CONTROL_TYPE_RANGE) {
            return parseFloat(value);
        }
        else if (this.controlData.control_type == Control.CONTROL_TYPE_INT) {
            return parseInt(value);
        }
        else if (this.controlData.control_type == Control.CONTROL_TYPE_BOOLEAN) {
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

        return value;
    }

    queryPath() {
        return this.cmdQueryPath;
    }

    static matchHexIntToRE(text: string, re : RegExp) {
        return HTTPCommand.matchIntToRE(text, re, 16);
    }

    static matchIntToRE(text : string, re : RegExp, radix = 10) {
        let matches = text.match(re);
        if (matches && matches.length > 1) {
            return parseInt(matches[1], radix);
        }
    }

    static matchBoolToRE(text: string, re : RegExp) {
        let matches = text.match(re);
        if (matches && matches.length > 1) {
            let val = matches[1];
            if (val == "true" || val == "1") {
                return true;
            }
            return false;
        }
    }


}
