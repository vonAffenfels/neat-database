"use strict";

// @IMPORTS
var Module = require("neat-base").Module;
var mongoose = require("mongoose");
var Application = require("neat-base").Application;
var Promise = require("bluebird");
var apeStatus = require("ape-status");
var fs = require("fs");

mongoose.Promise = Promise;

module.exports = class Database extends Module {

    static defaultConfig() {
        return {
            connections: {
                default: {
                    uri: "mongodb://127.0.0.1:27017/neat"
                }
            },
            modelRoot: "models"
        }
    }

    init() {
        return new Promise((resolve, reject) => {
            this.log.debug("Initializing...");
            this.connections = {};
            this.mongoose = mongoose;
            this.loadModels().then(() => {
                return resolve(this);
            });
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
                            server: {
                                poolSize: config.poolSize,
                                reconnectTries: 60 * 60 * 24,
                                reconnectInterval: 5000,
                                socketOptions: {
                                    keepAlive: 1,
                                    connectTimeoutMS: 30000
                                }
                            },
                            replset: {
                                rs_name: config.rs_name,
                                socketOptions: {
                                    keepAlive: 1,
                                    connectTimeoutMS: 30000
                                }
                            }
                        };

                        if(config.user){
                            options["user"] = config.user;
                            options["pass"] = config.pass;
                        }
                    }
                    else if(config.authSource) {
                        options = {
                            auth: {
                                authSource: config.authSource
                            }
                        };

                        if(config.user){
                            options["user"] = config.user;
                            options["pass"] = config.pass;
                        }
                    }

                    if (key === "default") {

                        this.connections[key] = mongoose.connection;
                        this.connections[key].on('error', (err) => {
                            this.log.error(err);
                        });

                        mongoose.connect(config.uri, options).then(() => {
                            this.log.info("Connected to " + key);
                            apeStatus.mongoose(this.connections[key], "apeStatus");
                            resolve();
                        }, (err) => {
                            // err is a Replset it doesn't make any sense
                            this.log.error(err);
                            return reject(new Error("Error while connecting to default db"));
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

    getModel(modelName) {
        return mongoose.model(modelName);
    }

    registerModel(modelName, schema) {

        for (let i = 0; i < Application.moduleObjs.length; i++) {
            if (Application.moduleObjs[i].instance.modifySchema) {
                Application.moduleObjs[i].instance.modifySchema(modelName, schema);
            }
        }

        try {
            mongoose.model(modelName, schema);
            this.log.debug("Loaded model " + modelName);
        } catch (e) {
            this.log.error(e);
        }
    }

    loadModels() {
        return new Promise((resolve, reject) => {
            var rootDir = Application.config.root_path + "/" + this.config.modelRoot;

            if (!fs.existsSync(rootDir)) {
                fs.mkdirSync(rootDir);
            }

            return new Promise((resolve, reject) => {
                fs.readdir(rootDir, (err, data) => {
                    if (err) {
                        return reject(err);
                    }

                    return resolve(data);
                });
            }).then((files) => {
                return Promise.map(files, (file) => {
                    var modelName = file.replace(".js", "");
                    this.registerModel(modelName, require(rootDir + "/" + file));
                    return Promise.resolve();
                })
            }, reject).then(resolve, reject);
        });
    }


    modifySchema(modelName, schema) {
        var self = this;

        schema.add({
            _createdAt: {
                type: Date,
                default: function () {
                    return new Date();
                }
            },
            _createdBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "user",
                default: null
            },

            _updatedAt: {
                type: Date,
                default: function () {
                    return new Date();
                }
            },
            _updatedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "user",
                default: null
            },

            _versions: {
                type: [mongoose.Schema.Types.Mixed],
                default: []
            },

            _version: {
                type: Number,
                default: null
            }
        });

        if (schema.options.toJSON.transform && typeof schema.options.toJSON.transform === "function") {
            schema.options.toJSON._transform = schema.options.toJSON.transform;
        }

        schema.options.toJSON.transform = function (doc) {
            if (schema.options.toJSON._transform) {
                var obj = schema.options.toJSON._transform(doc);
            } else {
                if (schema.options.toJSON.virtuals) {
                    obj = doc.toJSON({
                        virtuals: true,
                        transform: false
                    });
                } else {
                    obj = doc.toJSON({
                        transform: false
                    });
                }
            }

            delete obj._versions;

            // ok this is weird, but mongoose doesnt call transforms on sub documents ... unfortunate when it comes to stuff like user passwords and the _versions key
            // SOOOOO let's do it ourselves i guess :(
            for (var path in schema.paths) {
                var pathObj = schema.paths[path];

                if (pathObj.options.ref) {
                    var val = doc.get(path);
                    if (val && val instanceof mongoose.Model) {
                        obj[path] = val.toJSON();
                    }
                }
            }

            return obj;
        };

        schema.pre("save", function (next) {
            this._updatedAt = new Date();

            if (!schema.options.versionsDisabled) {
                var model = self.getModel(modelName);
                var lastVersion = this._versions && this._versions.length ? this._versions[this._versions.length - 1]._version : 0;
                var newVersion = new model(this.toJSON());

                // for the version we dont want to save anything populated
                for (var path in schema.paths) {
                    var pathObj = schema.paths[path];

                    if (pathObj.options.ref) {
                        var val = this.get(path);
                        if (val && val instanceof mongoose.Model) {
                            newVersion.set(path, val._id);
                        }
                    }
                }

                newVersion = newVersion.toJSON();
                delete newVersion._versions;
                newVersion._version = lastVersion + 1;
                this._versions.push(newVersion);

                if (this._versions.length > schema.options.versionCount) {
                    this._versions.shift();
                }
            }

            return next();
        });
    }

};
