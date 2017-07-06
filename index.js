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
                    var self = this;

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

                        if (config.user) {
                            options["user"] = config.user;
                            options["pass"] = config.pass;
                        }
                    }
                    else if (config.authSource) {
                        options = {
                            auth: {
                                authSource: config.authSource
                            }
                        };

                        if (config.user) {
                            options["user"] = config.user;
                            options["pass"] = config.pass;
                        }
                    }


                    if (key === "default") {
                        this.connections[key] = mongoose.connection;
                        this.connections[key].on('error', (err) => {
                            this.log.error(err);
                        });

                        apeStatus.mongoose(this.connections[key], "apeStatus");

                        (function initialConnect() {
                            mongoose.connect(config.uri, options, (err) => {
                                if (err) {
                                    self.log.error(err);
                                    self.log.info("Retrying in 1 second");
                                    return setTimeout(initialConnect, 1000);
                                }

                                self.log.info("Connected to " + key);
                                resolve();
                            });
                        })()
                    } else {
                        apeStatus.mongoose(this.connections[key], "apeStatus");
                        this.connections[key] = mongoose.createConnection(config.uri, options, (err) => {
                            if (err) {
                                this.log.error(err);
                                return reject(err);
                            }

                            this.log.info("Connected to " + key);
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

        try {
            if (mongoose.model(modelName)) {
                this.log.error("Model " + modelName + " already exists!!!! (or loaded twice!)");
                return;
            }
        } catch (e) {
            // we are just checking for duplicates, so if there is an error the model doesnt exist, so its fine, stupid hu ? :D
        }

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
        let self = this;

        if (!schema) {
            return;
        }

        schema.add({
            _createdAt: {
                type: Date,
                permission: false,
                default: function () {
                    return new Date();
                }
            },
            _createdBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "user",
                permission: false,
                default: null
            },

            _updatedAt: {
                type: Date,
                permission: false,
                default: function () {
                    return new Date();
                }
            },
            _updatedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "user",
                permission: false,
                default: null
            },

            _versions: {
                type: [mongoose.Schema.Types.Mixed],
                permission: false,
                default: []
            },

            _version: {
                type: Number,
                permission: false,
                default: null
            }
        });

        if (!schema.options.toJSON) {
            schema.options.toJSON = {};
        }

        if (schema.options.toJSON.transform && typeof schema.options.toJSON.transform === "function") {
            schema.options.toJSON._transform = schema.options.toJSON.transform;
        }

        schema.options.toJSON.transform = function (doc) {
            if (schema.options.toJSON._transform) {
                var obj = schema.options.toJSON._transform(doc);
            } else {
                if (schema.options.toJSON.virtuals || schema.options.toJSON.getters) {
                    obj = doc.toJSON({
                        getters: schema.options.toJSON.getters,
                        virtuals: schema.options.toJSON.virtuals,
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
            for (let path in schema.paths) {
                let pathObj = schema.paths[path];

                if (pathObj.options.ref) {
                    let val = doc.get(path);
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
                let model = self.getModel(modelName);
                let lastVersion = this._versions && this._versions.length ? this._versions[this._versions.length - 1]._version : 0;
                let newVersion = new model();

                // for the version we dont want to save anything populated
                for (let path in schema.paths) {
                    let val = this.get(path);
                    if (val && val instanceof mongoose.Model) {
                        newVersion.set(path, val._id);
                    } else if (val) {
                        newVersion.set(path, val);
                    }
                }

                newVersion = newVersion.toJSON({
                    virtuals: false,
                    getters: false,
                    transform: false
                });
                delete newVersion._versions;
                newVersion._version = lastVersion + 1;
                this._versions.push(newVersion);

                let maxVersionCount = schema.options.versionCount || 100;

                while (this._versions.length > maxVersionCount) {
                    this._versions.shift();
                }
            }

            return next();
        });

        schema.methods.getLinked = function () {
            return new Promise((resolve, reject) => {
                let checks = [];

                for (let testModelName in mongoose.modelSchemas) {
                    let testModel = mongoose.model(testModelName);
                    let possiblePaths = self.getPossibleLinkPathsFromModel(testModel, modelName);

                    if (possiblePaths) {
                        let query = {
                            $or: []
                        };

                        for (let path in possiblePaths) {
                            let subQuery = {};
                            subQuery[path] = this._id;
                            query.$or.push(subQuery);
                        }

                        checks.push(new Promise((resolve, reject) => {
                            return testModel.find(query).select({_id: true}).then((docs) => {

                                if (!docs || !docs.length) {
                                    return resolve(null);
                                }

                                let ids = docs.map(doc => doc._id);
                                return resolve({
                                    model: testModelName,
                                    data: ids,
                                });
                            });
                        }));
                    }
                }

                return Promise.all(checks).then((results) => {
                    results = results.filter(v => !!v);


                    if (results.length === 0) {
                        return resolve(null);
                    }

                    let resultMap = {};

                    for (let i = 0; i < results.length; i++) {
                        let obj = results[i];
                        resultMap[obj.model] = obj.data;
                    }

                    return resolve(resultMap)
                });
            });
        }
    }

    getPossibleLinkPathsFromModel(model, searchedModel) {
        let paths = {};
        for (let path in model.schema.paths) {
            let pathConfig = model.schema.paths[path];

            if (pathConfig.instance === "Array") {
                // check for simple reference array
                if (pathConfig.caster.instance === "ObjectID") {
                    pathConfig = pathConfig.caster; // just set pathConfig to the caster, later check will get it
                }

                // check for other arrays
                // @TODO
            }

            // regular single reference path
            if (pathConfig.options && pathConfig.options.ref) {
                if (searchedModel && pathConfig.options.ref !== searchedModel) {
                    continue;
                }

                paths[path] = pathConfig.options.ref;
            }
        }

        if (Object.keys(paths).length === 0) {
            return null;
        }

        return paths;
    }

};
