import * as cp from 'child_process';
import * as fs from 'fs';
import {EndpointCommunicator} from "@devctrl/lib-communicator";


/*
* The export of a DevCtrl protocol package should implement the ICommunicatorProtoPackage interface.
* The index.js file of the module must contain the line:
*   //devctrl-proto-package
 */

export interface ICommunicatorProtoPackage {
    communicators: {
        [index: string] : typeof EndpointCommunicator
    }
}


/*
The CommunicatorLoader searches all node modules for the line:
//devctrl-proto-package

Matching modules are then required and any exported communicators are added to the list of available communicators
 */

export class CommunicatorLoader {
    communicators = {};

    constructor() {
        let outlines = [];
        let dirs = [
            './node_modules',
            '../node_modules',
            '/usr/lib/node_modules'
        ];

        for (let dir of dirs) {
            if (fs.existsSync(dir)) {
                // Find paths under node_modules to index.js files which contain "//devctrl-proto-package"
                try {
                    let out = cp.execSync(`find -L ${dir} -name index.js | xargs grep devctrl-proto-package`);
                    let outStr = out.toString();
                    outlines = outlines.concat(outStr.split('\n'));
                }
                catch (e) {
                    console.log(`find devctrl-proto-package failed for ${dir}: ${e.error}`);
                }
            }
        }

        for (let line of outlines) {
            if (line.length) {
                console.log(`out line: ${line}`);
                // line format is filepath:line contents
                let lineParts = line.split(':');
                let filePath = lineParts[0];

                // Sanity check
                if (filePath.substr(-9) != "/index.js") {
                    console.log("weird filePath: " + filePath);
                    continue;
                }

                let pathParts = filePath.split('/');
                let modulePath = "";

                pathParts.forEach((part, index) => {
                    if (part == "node_modules") {
                        modulePath = pathParts.slice(index + 1, -1).join("/");
                    }
                    if (part == ".." || part == ".") {
                        modulePath = pathParts.slice(index, -1).join("/");
                    }
                });

                console.log(`module path found: ${modulePath}`);
                let communicatorPackage : ICommunicatorProtoPackage = require(modulePath);

                for (let commPath in communicatorPackage.communicators) {
                    this.communicators[commPath] = communicatorPackage.communicators[commPath];
                }
            }
        }
    }

}
