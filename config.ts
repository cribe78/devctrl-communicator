let fs = require('fs');

let config = {
  wsUrl : "https://devctrl.dwi.ufl.edu/",
  endpointId : "overrideme",
  ioPath: "/socket.io",
  endpointPassword : "DWCONTROL",
  authId: "overrideme",
};

let localConfig = {};
let localPath = "./config.local.js";

if (fs.existsSync(localPath)) {
  localConfig = require("./config.local");
}

for (let opt in localConfig) {
  config[opt] = localConfig[opt];
}

let customConfig = {};

if (typeof process.argv[2] !== 'undefined') {

  console.log("arg 2 is " + process.argv[2]);
  let configArg = process.argv[2];
  let configPath = "./conf/" + configArg + ".js";

  if (fs.existsSync(configPath)) {
    console.log(`loading ${configPath}`);
    customConfig = require("./conf/" + configArg);
  }
  else {
    console.log(`${configPath} not found`);
  }
}

for (let opt in customConfig) {
    config[opt] = customConfig[opt];
}

module.exports =  config;