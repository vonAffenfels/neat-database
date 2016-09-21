"use strict";

// @IMPORTS
var Module = require("neat-base").Module;
var mongoose = require("mongoose");
var Application = require("neat-base").Application;
var Promise = require("bluebird");
var apeStatus = require("ape-status");

mongoose.Promise = Promise;

module.exports = class Database extends Module {

    static defaultConfig() {
        return {
            connections: {
                default: {
                    uri: "mongodb://127.0.0.1:27017/neat"
                }
            }
        }
    }

    init() {
        return new Promise((resolve, reject) => {
            this.log.debug("Initializing...");
            this.connections = {};
            resolve(this);
        });
    }

    start() {
        return new Promise((resolve, reject) => {
            this.log.debug("Connecting...");

            Promise.each(Object.keys(this.config.connections), (key) => {
                return new Promise((resolve, reject) => {
                    var config = this.config.connections[key];
                    var options = {};

                    if (config.rs_name) {
                        options = {
                            auth: {
                                authSource: config.authSource || "admin"
                            },
                            poolSize: config.poolSize,
                            rs_name: config.rs_name,
                            server: {
                                reconnectTries: 60 * 60 * 24,
                                reconnectInterval: 5000,
                                socketOptions: {
                                    keepAlive: 1,
                                    connectTimeoutMS: 30000
                                }
                            },
                            replset: {
                                socketOptions: {
                                    keepAlive: 1,
                                    connectTimeoutMS: 30000
                                }
                            }
                        };
                    }

                    if (key === "default") {
                        mongoose.connect(config.uri, options, (err) => {
                            if (err) {
                                this.log.error(err);
                                return reject(err);
                            }

                            this.log.info("Connected to " + key);
                            apeStatus.mongoose(this.connections[key], "apeStatus");
                            resolve();
                        });

                        this.connections[key] = mongoose.connection;
                        this.connections[key].on('error', (err) => {
                            this.log.error(err);
                        });
                    } else {
                        this.connections[key] = mongoose.createConnection(config.uri, options, (err) => {
                            if (err) {
                                this.log.error(err);
                                return reject(err);
                            }

                            this.log.info("Connected to " + key);
                            apeStatus.mongoose(this.connections[key], "apeStatus");
                            resolve();
                        });

                        this.connections[key].on('error', (err) => {
                            this.log.error(err);
                        });
                        mongoose.connection = this.connections[key];
                    }
                });
            }).then(() => {
                return resolve(this);
            }, reject);
        });
    }

    stop() {
        return new Promise((resolve, reject) => {
            this.log.debug("Stopping...");

            for (var key in this.connections) {
                this.connections[key].close();
            }

            resolve(this);
        });
    }

    registerModel(modelName, schema) {
        this.log.debug("Loading model " + modelName);

        for (let i = 0; i < Application.moduleObjs.length; i++) {
            if (Application.moduleObjs[i].instance.modifySchema) {
                Application.moduleObjs[i].instance.modifySchema(modelName, schema);
            }
        }

        try {
            mongoose.model(modelName, schema);
        } catch (e) {
            this.log.error(e);
        }
    }

}
