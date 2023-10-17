define([
    'jquery',
    'chainpad-listmap',
    '/components/chainpad-crypto/crypto.js',
    '/common/common-util.js',
    '/common/outer/network-config.js',
    '/common/common-credential.js',
    '/components/chainpad/chainpad.dist.js',
    '/common/common-realtime.js',
    '/common/common-constants.js',
    '/common/common-interface.js',
    '/common/common-feedback.js',
    '/common/hyperscript.js',
    '/common/outer/local-store.js',
    '/customize/messages.js',
    '/components/nthen/index.js',
    '/common/outer/login-block.js',
    '/common/common-hash.js',
    '/common/outer/http-command.js',

    '/components/tweetnacl/nacl-fast.min.js',
    '/components/scrypt-async/scrypt-async.min.js', // better load speed
], function ($, Listmap, Crypto, Util, NetConfig, Cred, ChainPad, Realtime, Constants, UI,
            Feedback, h, LocalStore, Messages, nThen, Block, Hash, ServerCommand) {
    var Exports = {
        Cred: Cred,
        Block: Block,
        // this is depended on by non-customizable files
        // be careful when modifying login.js
        requiredBytes: 192,
    };

    var Nacl = window.nacl;

    var redirectTo = '/drive/';
    var setRedirectTo = function () {
        var parsed = Hash.parsePadUrl(window.location.href);
        if (parsed.hashData && parsed.hashData.newPadOpts) {
            var newPad = Hash.decodeDataOptions(parsed.hashData.newPadOpts);
            redirectTo = newPad.href;
        }
    };
    if (window.location.hash) {
        setRedirectTo();
    }

    var allocateBytes = Exports.allocateBytes = function (bytes) {
        var dispense = Cred.dispenser(bytes);

        var opt = {};

        // dispense 18 bytes of entropy for your encryption key
        var encryptionSeed = dispense(18);
        // 16 bytes for a deterministic channel key
        var channelSeed = dispense(16);
        // 32 bytes for a curve key
        var curveSeed = dispense(32);

        var curvePair = Nacl.box.keyPair.fromSecretKey(new Uint8Array(curveSeed));
        opt.curvePrivate = Nacl.util.encodeBase64(curvePair.secretKey);
        opt.curvePublic = Nacl.util.encodeBase64(curvePair.publicKey);

        // 32 more for a signing key
        var edSeed = opt.edSeed = dispense(32);

        // 64 more bytes to seed an additional signing key
        var blockKeys = opt.blockKeys = Block.genkeys(new Uint8Array(dispense(64)));
        opt.blockHash = Block.getBlockHash(blockKeys);

        // derive a private key from the ed seed
        var signingKeypair = Nacl.sign.keyPair.fromSeed(new Uint8Array(edSeed));

        opt.edPrivate = Nacl.util.encodeBase64(signingKeypair.secretKey);
        opt.edPublic = Nacl.util.encodeBase64(signingKeypair.publicKey);

        var keys = opt.keys = Crypto.createEditCryptor(null, encryptionSeed);

        // 24 bytes of base64
        keys.editKeyStr = keys.editKeyStr.replace(/\//g, '-');

        // 32 bytes of hex
        var channelHex = opt.channelHex = Util.uint8ArrayToHex(channelSeed);

        // should never happen
        if (channelHex.length !== 32) { throw new Error('invalid channel id'); }

        var channel64 = Util.hexToBase64(channelHex);

        // we still generate a v1 hash because this function needs to deterministically
        // derive the same values as it always has. New accounts will generate their own
        // userHash values
        opt.userHash = '/1/edit/' + [channel64, opt.keys.editKeyStr].join('/') + '/';

        return opt;
    };


    var loginOptionsFromBlock = Exports.loginOptionsFromBlock = function (blockInfo) {
        var opt = {};
        var parsed = Hash.getSecrets('pad', blockInfo.User_hash);
        opt.channelHex = parsed.channel;
        opt.keys = parsed.keys;
        opt.edPublic = blockInfo.edPublic;
        return opt;
    };

    var loadUserObject = Exports.loadUserObject = function (opt, _cb) {
        var cb = Util.once(Util.mkAsync(_cb));
        var config = {
            websocketURL: NetConfig.getWebsocketURL(),
            channel: opt.channelHex,
            data: {},
            validateKey: opt.keys.validateKey, // derived validation key
            crypto: Crypto.createEncryptor(opt.keys),
            logLevel: 1,
            classic: true,
            ChainPad: ChainPad,
            owners: [opt.edPublic]
        };

        var rt = opt.rt = Listmap.create(config);
        rt.proxy
        .on('ready', function () {
            setTimeout(function () { cb(void 0, rt); });
        })
        .on('error', function (info) {
            cb(info.type, {reason: info.message});
        })
        .on('disconnect', function (info) {
            cb('E_DISCONNECT', info);
        });
    };

    var isProxyEmpty = function (proxy) {
        var l = Object.keys(proxy).length;
        return l === 0 || (l === 2 && proxy._events && proxy.on);
    };

    var setMergeAnonDrive = function () {
        Exports.mergeAnonDrive = 1;
    };

    Exports.loginOrRegister = function (uname, passwd, isRegister, shouldImport, onOTP, cb) {
        if (typeof(cb) !== 'function') { return; }

        // Usernames are all lowercase. No going back on this one
        uname = uname.toLowerCase();

        // validate inputs
        if (!Cred.isValidUsername(uname)) { return void cb('INVAL_USER'); }
        if (!Cred.isValidPassword(passwd)) { return void cb('INVAL_PASS'); }
        if (isRegister && !Cred.isLongEnoughPassword(passwd)) {
            return void cb('PASS_TOO_SHORT');
        }

        // results...
        var res = {
            register: isRegister,
        };

        var RT, blockKeys, blockHash, blockUrl, Pinpad, rpc, userHash;

        nThen(function (waitFor) {
            // derive a predefined number of bytes from the user's inputs,
            // and allocate them in a deterministic fashion
            Cred.deriveFromPassphrase(uname, passwd, Exports.requiredBytes, waitFor(function (bytes) {
                res.opt = allocateBytes(bytes);
                blockHash = res.opt.blockHash;
                blockKeys = res.opt.blockKeys;
            }));
        }).nThen(function (waitFor) {
            // the allocated bytes can be used either in a legacy fashion,
            // or in such a way that a previously unused byte range determines
            // the location of a layer of indirection which points users to
            // an encrypted block, from which they can recover the location of
            // the rest of their data

            // determine where a block for your set of keys would be stored
            blockUrl = Block.getBlockUrl(res.opt.blockKeys);

            var TOTP_prompt = function (err, cb) {
                onOTP(function (code) {
                    ServerCommand(res.opt.blockKeys.sign, {
                        command: 'TOTP_VALIDATE',
                        code: code,
                        // TODO optionally allow the user to specify a lifetime for this session?
                        // this will require a little bit of server work
                        // and more UI/UX:
                        // ie. just a simple "remember me" checkbox?
                        // allow them to specify a lifetime for the session?
                        // "log me out after one day"?
                    }, cb);
                }, false, err);
            };

            var done = waitFor();
            var responseToDecryptedBlock = function (response, cb) {
                response.arrayBuffer().then(arraybuffer => {
                    arraybuffer = new Uint8Array(arraybuffer);
                    var decryptedBlock =  Block.decrypt(arraybuffer, blockKeys);
                    if (!decryptedBlock) {
                        console.error("BLOCK DECRYPTION ERROR");
                        return void cb("BLOCK_DECRYPTION_ERROR");
                    }
                    cb(void 0, decryptedBlock);
                });
            };

            var TOTP_response;
            nThen(function (w) {
                Util.getBlock(blockUrl, {
                // request the block without credentials
                }, w(function (err, response) {
                    if (err === 401) {
                        return void console.log("Block requires 2FA");
                    }

                    if (err === 404 && response && response.reason) {
                        waitFor.abort();
                        w.abort();
                        /*
                        // the following block prevent users from re-using an old password
                        if (isRegister) { return void cb('HAS_PLACEHOLDER'); }
                        */
                        return void cb('DELETED_USER', response);
                    }

                    // Some other error?
                    if (err) {
                        console.error(err);
                        w.abort();
                        return void done();
                    }

                    // If the block was returned without requiring authentication
                    // then we can abort the subsequent steps of this nested nThen
                    w.abort();

                    // decrypt the response and continue the normal procedure with its payload
                    responseToDecryptedBlock(response, function (err, decryptedBlock) {
                        if (err) {
                            // if a block was present but you were not able to decrypt it...
                            console.error(err);
                            waitFor.abort();
                            return void cb(err);
                        }
                        res.blockInfo = decryptedBlock;
                        done();
                    });
                }));
            }).nThen(function (w) {
                // if you're here then you need to request a JWT
                var done = w();
                var tries = 3;
                var ask = function () {
                    if (!tries) {
                        w.abort();
                        waitFor.abort();
                        return void cb('TOTP_ATTEMPTS_EXHAUSTED');
                    }
                    tries--;
                    TOTP_prompt(tries !== 2, function (err, response) {
                        // ask again until your number of tries are exhausted
                        if (err) {
                            console.error(err);
                            console.log("Normal failure. Asking again...");
                            return void ask();
                        }
                        if (!response || !response.bearer) {
                            console.log(response);
                            console.log("Unexpected failure. No bearer token. Asking again");
                            return void ask();
                        }
                        console.log("Successfully retrieved a bearer token");
                        res.TOTP_token = TOTP_response = response;
                        done();
                    });
                };
                ask();
            }).nThen(function (w) {
                Util.getBlock(blockUrl, TOTP_response, function (err, response) {
                    if (err) {
                        w.abort();
                        console.error(err);
                        return void cb('BLOCK_ERROR_3');
                    }

                    responseToDecryptedBlock(response, function (err, decryptedBlock) {
                        if (err) {
                            waitFor.abort();
                            return void cb(err);
                        }
                        res.blockInfo = decryptedBlock;
                        done();
                    });
                });
            });
        }).nThen(function (waitFor) {
            // we assume that if there is a block, it was created in a valid manner
            // so, just proceed to the next block which handles that stuff
            if (res.blockInfo) { return; }

            var opt = res.opt;

            // load the user's object using the legacy credentials
            loadUserObject(opt, waitFor(function (err, rt) {
                if (err) {
                    waitFor.abort();
                    if (err === 'EDELETED') { return void cb('DELETED_USER', rt); }
                    return void cb(err);
                }

                // if a proxy is marked as deprecated, it is because someone had a non-owned drive
                // but changed their password, and couldn't delete their old data.
                // if they are here, they have entered their old credentials, so we should not
                // allow them to proceed. In time, their old drive should get deleted, since
                // it will should be pinned by anyone's drive.
                if (rt.proxy[Constants.deprecatedKey]) {
                    waitFor.abort();
                    return void cb('NO_SUCH_USER', res);
                }

                if (isRegister && isProxyEmpty(rt.proxy)) {
                    // If they are trying to register,
                    // and the proxy is empty, then there is no 'legacy user' either
                    // so we should just shut down this session and disconnect.
                    //rt.network.disconnect();
                    return; // proceed to the next async block
                }

                // they tried to just log in but there's no such user
                // and since we're here at all there is no modern-block
                if (!isRegister && isProxyEmpty(rt.proxy)) {
                    //rt.network.disconnect(); // clean up after yourself
                    waitFor.abort();
                    return void cb('NO_SUCH_USER', res);
                }

                // they tried to register, but those exact credentials exist
                if (isRegister && !isProxyEmpty(rt.proxy)) {
                    //rt.network.disconnect();
                    waitFor.abort();
                    Feedback.send('LOGIN', true);
                    return void cb('ALREADY_REGISTERED', res);
                }

                // if you are here, then there is no block, the user is trying
                // to log in. The proxy is **not** empty. All values assigned here
                // should have been deterministically created using their credentials
                // so setting them is just a precaution to keep things in good shape
                res.proxy = rt.proxy;
                res.realtime = rt.realtime;
                res.network = rt.network;

                // they're registering...
                res.userHash = opt.userHash;
                res.userName = uname;

                // export their signing key
                res.edPrivate = opt.edPrivate;
                res.edPublic = opt.edPublic;

                // export their encryption key
                res.curvePrivate = opt.curvePrivate;
                res.curvePublic = opt.curvePublic;

                if (shouldImport) { setMergeAnonDrive(); }

                // don't proceed past this async block.
                waitFor.abort();

                // We have to call whenRealtimeSyncs asynchronously here because in the current
                // version of listmap, onLocal calls `chainpad.contentUpdate(newValue)`
                // asynchronously.
                // The following setTimeout is here to make sure whenRealtimeSyncs is called after
                // `contentUpdate` so that we have an update userDoc in chainpad.
                setTimeout(function () {
                    Realtime.whenRealtimeSyncs(rt.realtime, function () {
                        // the following stages are there to initialize a new drive
                        // if you are registering
                        LocalStore.login(res.userHash, undefined, res.userName, function () {
                            setTimeout(function () { cb(void 0, res); });
                        });
                    });
                });
            }));
        }).nThen(function (waitFor) { // MODERN REGISTRATION / LOGIN
            var opt;
            if (res.blockInfo) {
                opt = loginOptionsFromBlock(res.blockInfo);
                userHash = res.blockInfo.User_hash;
                //console.error(opt, userHash);
            } else {
                console.log("allocating random bytes for a new user object");
                opt = allocateBytes(Nacl.randomBytes(Exports.requiredBytes));
                // create a random v2 hash, since we don't need backwards compatibility
                userHash = opt.userHash = Hash.createRandomHash('drive');
                var secret = Hash.getSecrets('drive', userHash);
                opt.keys = secret.keys;
                opt.channelHex = secret.channel;
            }

            // according to the location derived from the credentials which you entered
            loadUserObject(opt, waitFor(function (err, rt) {
                if (err) {
                    waitFor.abort();
                    if (err === 'EDELETED') { return void cb('DELETED_USER', rt); }
                    return void cb('MODERN_REGISTRATION_INIT');
                }

                //console.error(JSON.stringify(rt.proxy));

                // export the realtime object you checked
                RT = rt;

                var proxy = rt.proxy;
                if (isRegister && !isProxyEmpty(proxy) && (!proxy.edPublic || !proxy.edPrivate)) {
                    console.error("INVALID KEYS");
                    console.log(JSON.stringify(proxy));
                    return;
                }

                res.proxy = rt.proxy;
                res.realtime = rt.realtime;
                res.network = rt.network;

                // they're registering...
                res.userHash = userHash;
                res.userName = uname;

                // somehow they have a block present, but nothing in the user object it specifies
                // this shouldn't happen, but let's send feedback if it does
                if (!isRegister && isProxyEmpty(rt.proxy)) {
                    // this really shouldn't happen, but let's handle it anyway
                    Feedback.send('EMPTY_LOGIN_WITH_BLOCK');

                    //rt.network.disconnect(); // clean up after yourself
                    waitFor.abort();
                    return void cb('NO_SUCH_USER', res);
                }

                // they tried to register, but those exact credentials exist
                if (isRegister && !isProxyEmpty(rt.proxy)) {
                    //rt.network.disconnect();
                    waitFor.abort();
                    res.blockHash = blockHash;
                    if (shouldImport) {
                        setMergeAnonDrive();
                    }

                    return void cb('ALREADY_REGISTERED', res);
                }

                if (!isRegister && !isProxyEmpty(rt.proxy)) {
                    waitFor.abort();
                    if (shouldImport) {
                        setMergeAnonDrive();
                    }
                    var l = Util.find(rt.proxy, ['settings', 'general', 'language']);
                    var LS_LANG = "CRYPTPAD_LANG";
                    if (l) {
                        localStorage.setItem(LS_LANG, l);
                    }

                    if (res.TOTP_token && res.TOTP_token.bearer) {
                        LocalStore.setSessionToken(res.TOTP_token.bearer);
                    }
                    return void LocalStore.login(undefined, blockHash, uname, function () {
                        cb(void 0, res);
                    });
                }

                if (isRegister && isProxyEmpty(rt.proxy)) {
                    proxy.edPublic = opt.edPublic;
                    proxy.edPrivate = opt.edPrivate;
                    proxy.curvePublic = opt.curvePublic;
                    proxy.curvePrivate = opt.curvePrivate;
                    proxy.login_name = uname;
                    proxy[Constants.displayNameKey] = uname;
                    if (shouldImport) {
                        setMergeAnonDrive();
                    } else {
                        proxy.version = 11;
                    }

                    Feedback.send('REGISTRATION', true);
                } else {
                    Feedback.send('LOGIN', true);
                }

                setTimeout(waitFor(function () {
                    Realtime.whenRealtimeSyncs(rt.realtime, waitFor());
                }));
            }));
        }).nThen(function (waitFor) {
            require(['/common/pinpad.js'], waitFor(function (_Pinpad) {
                console.log("loaded rpc module");
                Pinpad = _Pinpad;
            }));
        }).nThen(function (waitFor) {
            // send an RPC to store the block which you created.
            console.log("initializing rpc interface");

            Pinpad.create(RT.network, Block.keysToRPCFormat(res.opt.blockKeys), waitFor(function (e, _rpc) {
                if (e) {
                    waitFor.abort();
                    console.error(e); // INVALID_KEYS
                    return void cb('RPC_CREATION_ERROR');
                }
                rpc = _rpc;
                console.log("rpc initialized");
            }));
        }).nThen(function (waitFor) {
            console.log("creating request to publish a login block");

            // Finally, create the login block for the object you just created.
            var toPublish = {};

            toPublish[Constants.userHashKey] = userHash;
            toPublish.edPublic = RT.proxy.edPublic;

            Block.writeLoginBlock({
                blockKeys: blockKeys,
                content: toPublish
            }, waitFor(function (e) {
                if (e) {
                    console.error(e);
                    waitFor.abort();
                    return void cb(e);
                }
            }));
        }).nThen(function (waitFor) {
            // confirm that the block was actually written before considering registration successful
            Util.fetch(blockUrl, waitFor(function (err /*, block */) {
                if (err) {
                    console.error(err);
                    waitFor.abort();
                    return void cb(err);
                }

                console.log("blockInfo available at:", blockHash);
                LocalStore.login(undefined, blockHash, uname, function () {
                    cb(void 0, res);
                });
            }));
        });
    };
    Exports.redirect = function () {
        if (redirectTo) {
            var h = redirectTo;
            var loginOpts = {};
            if (Exports.mergeAnonDrive) {
                loginOpts.mergeAnonDrive = 1;
            }
            h = Hash.getLoginURL(h, loginOpts);

            var parser = document.createElement('a');
            parser.href = h;
            if (parser.origin === window.location.origin) {
                window.location.href = h;
                return;
            }
        }
        window.location.href = '/drive/';
    };

    var hashing;
    Exports.loginOrRegisterUI = function (uname, passwd, isRegister, shouldImport, onOTP, testing, test) {
        if (hashing) { return void console.log("hashing is already in progress"); }
        hashing = true;

        var proceed = function (result) {
            hashing = false;
            // NOTE: test is also use as a cb for the install page
            if (test && typeof test === "function" && test(result)) { return; }
            LocalStore.clearLoginToken();
            Realtime.whenRealtimeSyncs(result.realtime, function () {
                Exports.redirect();
            });
        };

        // setTimeout 100ms to remove the keyboard on mobile devices before the loading screen
        // pops up
        window.setTimeout(function () {
            UI.addLoadingScreen({
                loadingText: Messages.login_hashing,
                hideTips: true,
            });

            // We need a setTimeout(cb, 0) otherwise the loading screen is only displayed
            // after hashing the password
            window.setTimeout(function () {
                Exports.loginOrRegister(uname, passwd, isRegister, shouldImport, onOTP, function (err, result) {
                    var proxy;
                    if (result) { proxy = result.proxy; }

                    if (err) {
                        switch (err) {
                            case 'NO_SUCH_USER':
                                UI.removeLoadingScreen(function () {
                                    UI.alert(Messages.login_noSuchUser, function () {
                                        hashing = false;
                                        $('#password').focus();
                                    });
                                });
                                break;
                            case 'INVAL_USER':
                                UI.removeLoadingScreen(function () {
                                    UI.alert(Messages.login_notFilledUser , function () {
                                        hashing = false;
                                        $('#password').focus();
                                    });
                                });
                                break;
/*
                            case 'HAS_PLACEHOLDER':
                                UI.errorLoadingScreen('UNAVAILABLE', true, true);
                                break;
*/
                            case 'DELETED_USER':
                                UI.errorLoadingScreen(
                                    UI.getDestroyedPlaceholder(result.reason, true), true, () => {
                                        window.location.reload();
                                    });
                                break;
                            case 'INVAL_PASS':
                                UI.removeLoadingScreen(function () {
                                    UI.alert(Messages.login_notFilledPass, function () {
                                        hashing = false;
                                        $('#password').focus();
                                    });
                                });
                                break;
                            case 'PASS_TOO_SHORT':
                                UI.removeLoadingScreen(function () {
                                    var warning = Messages._getKey('register_passwordTooShort', [
                                        Cred.MINIMUM_PASSWORD_LENGTH
                                    ]);
                                    UI.alert(warning, function () {
                                        hashing = false;
                                        $('#password').focus();
                                    });
                                });
                                break;
                            case 'ALREADY_REGISTERED':
                                UI.removeLoadingScreen(function () {
                                    UI.confirm(Messages.register_alreadyRegistered, function (yes) {
                                        if (!yes) {
                                            hashing = false;
                                            return;
                                        }
                                        proxy.login_name = uname;

                                        if (!proxy[Constants.displayNameKey]) {
                                            proxy[Constants.displayNameKey] = uname;
                                        }

                                        var block = result.blockHash;
                                        var user = block ? undefined : result.userHash;
                                        LocalStore.login(user, block, result.userName, function () {
                                            setTimeout(function () { proceed(result); });
                                        });
                                    });
                                });
                                break;
                            case 'E_RESTRICTED':
                                UI.errorLoadingScreen(Messages.register_registrationIsClosed);
                                break;
                            default: // UNHANDLED ERROR
                                hashing = false;
                                UI.errorLoadingScreen(Messages.login_unhandledError);
                        }
                        return;
                    }

                    //if (testing) { return void proceed(result); }

                    if (!(proxy.curvePrivate && proxy.curvePublic &&
                          proxy.edPrivate && proxy.edPublic)) {

                        console.log("recovering derived public/private keypairs");
                        // **** reset keys ****
                        proxy.curvePrivate = result.curvePrivate;
                        proxy.curvePublic  = result.curvePublic;
                        proxy.edPrivate    = result.edPrivate;
                        proxy.edPublic     = result.edPublic;
                    }

                    setTimeout(function () {
                        Realtime.whenRealtimeSyncs(result.realtime, function () {
                            proceed(result);
                        });
                    });
                });
            }, 500);
        }, 200);
    };

    return Exports;
});
