import * as fs from 'fs';


export class DCConfig {
    wsUrl = "http://localhost:2880/";
    testString = "default";
    endpointId = "overrideme";
    mongoHost = "localhost";
    mongoPort = 27017;
    mongoDB = "devctrl";
    ioPort = 2880;
    ioPath = "/socket.io";
    authId = "overrideme";
    identifierName = "identifier";
    endpointPassword = "password";

    configParams = [
        'wsUrl',
        'testString',
        'endpointId',
        'mongoHost',
        'mongoPort',
        'mongoDB',
        'ioPort',
        'ioPath',
        'authId',
        'identifierName',
        'endpointPassword'
    ];



    configDirs = ['/etc/devctrl/', './', './conf/'];

    constructor(private confName : string = '') {
        // An array of file paths to check;
        let configFiles = [];

        let fileNames = ["config.json"];

        if (confName) {
            fileNames.push(`${confName}.json`);
        }

        // Assemble a list of potential config files
        for (let f of fileNames) {
            for (let dir of this.configDirs) {
                let file = dir + f;
                if (fs.existsSync(file)) {
                    configFiles.push(file);
                }
            }
        }

        for (let confPath of configFiles) {
            let confJson = fs.readFileSync(confPath, 'utf8');
            let confObj = JSON.parse(confJson);

            console.log(`configuration read from ${confPath}`);

            for (let param of this.configParams) {
                if (typeof confObj[param] !== 'undefined') {
                    this[param] = confObj[param];
                }
            }
        }
    }
}