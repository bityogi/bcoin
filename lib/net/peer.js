/*!
 * peer.js - peer object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var bcoin = require('../env');
var EventEmitter = require('events').EventEmitter;
var utils = require('../utils/utils');
var Parser = require('./parser');
var Framer = require('./framer');
var packets = require('./packets');
var packetTypes = packets.types;
var NetworkAddress = require('../primitives/netaddress');
var assert = utils.assert;
var constants = bcoin.constants;
var InvItem = bcoin.invitem;

/**
 * Represents a remote peer.
 * @exports Peer
 * @constructor
 * @param {Pool} pool
 * @param {NetworkAddress} addr
 * @param {net.Socket?} socket
 * @property {Pool} pool
 * @property {net.Socket?} socket
 * @property {String} host
 * @property {Number} port
 * @property {String} hostname
 * @property {Number} port
 * @property {Parser} parser
 * @property {Framer} framer
 * @property {Chain} chain
 * @property {Mempool} mempool
 * @property {Object?} version - Version packet payload.
 * @property {Boolean} destroyed
 * @property {Boolean} ack - Whether verack has been received.
 * @property {Boolean} connected
 * @property {Number} ts
 * @property {Boolean} preferHeaders - Whether the peer has
 * requested getheaders.
 * @property {Boolean} haveWitness - Whether the peer supports segwit,
 * either notified via service bits or deprecated `havewitness` packet.
 * @property {Hash?} hashContinue - The block hash at which to continue
 * the sync for the peer.
 * @property {Bloom?} spvFilter - The _peer's_ bloom spvFilter.
 * @property {Boolean} relay - Whether to relay transactions
 * immediately to the peer.
 * @property {BN} challenge - Local nonce.
 * @property {Number} lastPong - Timestamp for last `pong`
 * received (unix time).
 * @property {Number} lastPing - Timestamp for last `ping`
 * sent (unix time).
 * @property {Number} minPing - Lowest ping time seen.
 * @property {String} id - Peer's uid.
 * @property {Number} banScore
 * @emits Peer#ack
 */

function Peer(pool, addr, socket) {
  if (!(this instanceof Peer))
    return new Peer(pool, addr, socket);

  EventEmitter.call(this);

  this.pool = pool;
  this.options = pool.options;
  this.logger = pool.logger;
  this.socket = null;
  this.outbound = false;
  this.host = null;
  this.port = 0;
  this.hostname = null;
  this.createSocket = this.options.createSocket;
  this.chain = this.pool.chain;
  this.mempool = this.pool.mempool;
  this.network = this.chain.network;
  this.locker = new bcoin.locker(this);
  this.version = null;
  this.destroyed = false;
  this.ack = false;
  this.connected = false;
  this.ts = 0;
  this.preferHeaders = false;
  this.haveWitness = false;
  this.hashContinue = null;
  this.spvFilter = null;
  this.relay = true;
  this.feeRate = -1;
  this.addrFilter = new bcoin.bloom.rolling(5000, 0.001);
  this.invFilter = new bcoin.bloom.rolling(50000, 0.000001);
  this.lastBlock = null;
  this.waiting = 0;
  this.syncSent = false;
  this.connectTimeout = null;
  this.compactMode = null;
  this.compactBlocks = {};
  this.sentAddr = false;
  this.bip151 = null;
  this.bip150 = null;
  this.lastSend = 0;
  this.lastRecv = 0;

  this.challenge = null;
  this.lastPong = -1;
  this.lastPing = -1;
  this.minPing = -1;

  this.banScore = 0;

  this.pingTimeout = null;
  this.pingInterval = 120000;

  this.requestTimeout = 10000;
  this.requestMap = {};

  this.queueBlock = [];
  this.queueTX = [];

  this.uid = 0;
  this.id = Peer.uid++;

  this.setMaxListeners(10000);

  assert(addr, 'Host required.');

  this.host = addr.host;
  this.port = addr.port;
  this.hostname = addr.hostname;

  if (!socket) {
    this.socket = this.connect(this.port, this.host);
    this.outbound = true;
  } else {
    this.socket = socket;
    this.connected = true;
  }

  if (this.options.bip151) {
    this.bip151 = new bcoin.bip151();
    if (this.options.bip150) {
      this.bip150 = new bcoin.bip150(
        this.bip151,
        this.hostname,
        this.outbound,
        this.pool.auth,
        this.pool.identityKey);
      this.bip151.bip150 = this.bip150;
    }
  }

  this.parser = new Parser(this);
  this.framer = new Framer(this);

  this._init();
}

utils.inherits(Peer, EventEmitter);

/**
 * Globally incremented unique id.
 * @private
 * @type {Number}
 */

Peer.uid = 0;

/**
 * Begin peer initialization.
 * @private
 */

Peer.prototype._init = function init() {
  var self = this;

  this.socket.once('connect', function() {
    self._onConnect();
  });

  this.socket.once('error', function(err) {
    self.error(err);

    switch (err.code) {
      case 'ECONNREFUSED':
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
      case 'ENOTFOUND':
      case 'ECONNRESET':
        self.ignore();
        break;
      default:
        if (!self.connected)
          self.ignore();
        break;
    }
  });

  this.socket.once('close', function() {
    self.error('socket hangup');
  });

  this.socket.on('data', function(chunk) {
    self.parser.feed(chunk);
  });

  this.parser.on('packet', function(packet) {
    self._onPacket(packet);
  });

  this.parser.on('error', function(err) {
    self.error(err, true);
    self.reject(null, 'malformed', 'error parsing message', 10);
  });

  if (this.bip151) {
    this.bip151.on('error', function(err) {
      self.reject(null, 'malformed', 'error parsing message', 10);
      self.error(err, true);
    });
    this.bip151.on('rekey', function() {
      self.logger.debug('Rekeying with peer (%s).', self.hostname);
      self.send(self.bip151.toRekey());
    });
  }

  if (this.connected) {
    utils.nextTick(function() {
      self._onConnect();
    });
  }
};

/**
 * Invoke mutex lock.
 * @private
 */

Peer.prototype._lock = function _lock(func, args, force) {
  return this.locker.lock(func, args, force);
};

/**
 * Handle `connect` event (called immediately
 * if a socket was passed into peer).
 * @private
 */

Peer.prototype._onConnect = function _onConnect() {
  var self = this;

  this.ts = utils.now();
  this.connected = true;

  this.emit('connect');

  if (this.connectTimeout != null) {
    clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
  }

  // Send encinit. Wait for handshake to complete.
  if (this.bip151) {
    assert(!this.bip151.completed);
    this.logger.info('Attempting BIP151 handshake (%s).', this.hostname);
    this.send(this.bip151.toEncinit());
    return this.bip151.wait(3000, function(err) {
      if (err)
        self.error(err, true);
      self._onBIP151();
    });
  }

  this._onBIP151();
};

/**
 * Handle post bip151-handshake.
 * @private
 */

Peer.prototype._onBIP151 = function _onBIP151() {
  var self = this;

  if (this.bip151) {
    assert(this.bip151.completed);

    if (this.bip151.handshake) {
      this.logger.info('BIP151 handshake complete (%s).', this.hostname);
      this.logger.info('Connection is encrypted (%s).', this.hostname);
    }

    if (this.bip150) {
      assert(!this.bip150.completed);

      if (!this.bip151.handshake)
        return this.error('BIP151 handshake was not completed for BIP150.');

      this.logger.info('Attempting BIP150 handshake (%s).', this.hostname);

      if (this.bip150.outbound) {
        if (!this.bip150.peerIdentity)
          return this.error('No known identity for peer.');
        this.send(this.bip150.toChallenge());
      }

      return this.bip150.wait(3000, function(err) {
        if (err)
          return self.error(err);
        self._onHandshake();
      });
    }
  }

  this._onHandshake();
};

/**
 * Handle post handshake.
 * @private
 */

Peer.prototype._onHandshake = function _onHandshake() {
  var self = this;

  if (this.bip150) {
    assert(this.bip150.completed);
    if (this.bip150.auth) {
      this.logger.info('BIP150 handshake complete (%s).', this.hostname);
      this.logger.info('Peer is authed (%s): %s.',
        this.hostname, this.bip150.getAddress());
    }
  }

  this.request('verack', function(err) {
    self._onAck(err);
  });

  // Say hello.
  this.sendVersion();

  // Advertise our address.
  if (this.pool.address.host !== '0.0.0.0'
      && !this.options.selfish
      && this.pool.server) {
    this.send(new packets.AddrPacket([this.pool.address]));
  }
};

/**
 * Handle `ack` event (called on verack).
 * @private
 */

Peer.prototype._onAck = function _onAck(err) {
  var self = this;

  if (err) {
    this.error(err);
    return;
  }

  // Wait for _their_ version.
  if (!this.version) {
    this.logger.debug(
      'Peer sent a verack without a version (%s).',
      this.hostname);
    this.request('version', this._onAck.bind(this));
    return;
  }

  this.ack = true;

  // Setup the ping interval.
  this.pingTimeout = setInterval(function() {
    self.sendPing();
  }, this.pingInterval);

  // Ask for headers-only.
  if (this.options.headers) {
    if (this.version.version >= 70012)
      this.send(new packets.SendHeadersPacket());
  }

  // Let them know we support segwit (old
  // segwit3 nodes require this instead
  // of service bits).
  if (this.options.witness && this.network.oldWitness) {
    if (this.version.version >= 70012)
      this.send(new packets.HaveWitnessPacket());
  }

  // We want compact blocks!
  if (this.options.compact) {
    if (this.version.version >= 70014)
      this.sendCompact();
  }

  // Find some more peers.
  this.send(new packets.GetAddrPacket());

  // Relay our spv filter if we have one.
  this.updateWatch();

  // Announce our currently broadcasted items.
  this.announce(this.pool.invItems);

  // Set a fee rate filter.
  if (this.pool.feeRate !== -1)
    this.sendFeeRate(this.pool.feeRate);

  // Start syncing the chain.
  this.sync();

  this.logger.debug('Received verack (%s).', this.hostname);

  // Finally we can let the pool know
  // that this peer is ready to go.
  this.emit('ack');
};

/**
 * Create the socket and begin connecting. This method
 * will use `options.createSocket` if provided.
 * @param {String} host
 * @param {Number} port
 * @returns {net.Socket}
 */

Peer.prototype.connect = function connect(port, host) {
  var self = this;
  var socket, proxy, net;

  assert(!this.socket);

  if (this.createSocket) {
    socket = this.createSocket(port, host);
  } else {
    if (utils.isBrowser) {
      proxy = require('./proxysocket');
      socket = proxy.connect(this.pool.proxyServer, port, host);
    } else {
      net = require('net');
      socket = net.connect(port, host);
    }
  }

  this.logger.debug('Connecting to %s.', this.hostname);

  socket.once('connect', function() {
    self.logger.info('Connected to %s.', self.hostname);
  });

  this.connectTimeout = setTimeout(function() {
    self.error('Connection timed out.');
    self.ignore();
  }, 10000);

  return socket;
};

/**
 * Test whether the peer is the loader peer.
 * @returns {Boolean}
 */

Peer.prototype.isLoader = function isLoader() {
  return this === this.pool.peers.load;
};

/**
 * Broadcast items to peer (transactions or blocks).
 * @param {Block[]|TX[]|InvItem[]|BroadcastEntry[]} items
 */

Peer.prototype.announce = function announce(items) {
  var inv = [];
  var headers = [];
  var i, item, entry;

  if (this.destroyed)
    return;

  if (!Array.isArray(items))
    items = [items];

  for (i = 0; i < items.length; i++) {
    item = items[i];

    // Check the peer's bloom
    // filter if they're using spv.
    if (!this.isWatched(item))
      continue;

    // Convert item to block headers
    // for peers that request it.
    if (this.preferHeaders && item.toHeaders) {
      item = item.toHeaders();
      if (this.invFilter.test(item.hash()))
        continue;
      headers.push(item);
      continue;
    }

    if (item.toInv)
      item = item.toInv();

    // Do not send txs to spv clients
    // that have relay unset.
    if (!this.relay) {
      if (item.type === constants.inv.TX)
        continue;
    }

    // Filter according to peer's fee filter.
    if (this.feeRate !== -1 && this.mempool) {
      if (item.type === constants.inv.TX) {
        entry = this.mempool.getEntry(item.hash);
        if (entry && entry.getRate() < this.feeRate)
          continue;
      }
    }

    // Don't send if they already have it.
    if (this.invFilter.test(item.hash, 'hex'))
      continue;

    inv.push(item);
  }

  this.sendInv(inv);

  if (headers.length > 0)
    this.sendHeaders(headers);
};

/**
 * Send inv to a peer.
 * @param {InvItem[]} items
 */

Peer.prototype.sendInv = function sendInv(items) {
  var i, chunk;

  if (this.destroyed)
    return;

  if (!Array.isArray(items))
    items = [items];

  for (i = 0; i < items.length; i++)
    this.invFilter.add(items[i].hash, 'hex');

  if (items.length === 0)
    return;

  this.logger.spam('Serving %d inv items to %s.',
    items.length, this.hostname);

  for (i = 0; i < items.length; i += 50000) {
    chunk = items.slice(i, i + 50000);
    this.send(new packets.InvPacket(chunk));
  }
};

/**
 * Send headers to a peer.
 * @param {Headers[]} items
 */

Peer.prototype.sendHeaders = function sendHeaders(items) {
  var i, chunk;

  if (this.destroyed)
    return;

  if (!Array.isArray(items))
    items = [items];

  for (i = 0; i < items.length; i++)
    this.invFilter.add(items[i].hash());

  if (items.length === 0)
    return;

  this.logger.spam('Serving %d headers to %s.',
    items.length, this.hostname);

  for (i = 0; i < items.length; i += 2000) {
    chunk = items.slice(i, i + 2000);
    this.send(new packets.HeadersPacket(chunk));
  }
};

/**
 * Send a `version` packet.
 */

Peer.prototype.sendVersion = function sendVersion() {
  var packet = new packets.VersionPacket({
    version: constants.VERSION,
    services: this.pool.services,
    ts: bcoin.now(),
    recv: new NetworkAddress(),
    from: this.pool.address,
    nonce: this.pool.localNonce,
    agent: constants.USER_AGENT,
    height: this.chain.height,
    relay: this.options.relay
  });
  this.send(packet);
};

/**
 * Send a `ping` packet.
 */

Peer.prototype.sendPing = function sendPing() {
  if (!this.version)
    return;

  if (this.version.version <= 60000) {
    this.send(new packets.PingPacket());
    return;
  }

  if (this.challenge) {
    this.logger.debug('Peer has not responded to ping (%s).', this.hostname);
    return;
  }

  this.lastPing = utils.ms();
  this.challenge = utils.nonce();

  this.send(new packets.PingPacket(this.challenge));
};

/**
 * Test whether an is being watched by the peer.
 * @param {BroadcastItem|TX} item
 * @returns {Boolean}
 */

Peer.prototype.isWatched = function isWatched(item) {
  if (!this.spvFilter)
    return true;

  if (!item)
    return true;

  if (item instanceof bcoin.tx)
    return item.isWatched(this.spvFilter);

  if (item.msg instanceof bcoin.tx)
    return item.msg.isWatched(this.spvFilter);

  return true;
};

/**
 * Send `filterload` to update the local bloom filter.
 */

Peer.prototype.updateWatch = function updateWatch() {
  if (!this.options.spv)
    return;

  this.send(packets.FilterLoadPacket.fromFilter(this.pool.spvFilter));
};

/**
 * Set a fee rate filter for the peer.
 * @param {Rate} rate
 */

Peer.prototype.sendFeeRate = function sendFeeRate(rate) {
  this.send(new packets.FeeFilterPacket(rate));
};

/**
 * Disconnect from and destroy the peer.
 */

Peer.prototype.destroy = function destroy() {
  var i, j, keys, cmd, queue;

  if (this.destroyed)
    return;

  this.destroyed = true;
  this.connected = false;

  this.socket.destroy();
  this.socket = null;

  if (this.bip151)
    this.bip151.destroy();

  if (this.bip150)
    this.bip150.destroy();

  if (this.pingTimeout != null) {
    clearInterval(this.pingTimeout);
    this.pingTimeout = null;
  }

  if (this.connectTimeout != null) {
    clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
  }

  keys = Object.keys(this.requestMap);

  for (i = 0; i < keys.length; i++) {
    cmd = keys[i];
    queue = this.requestMap[cmd];

    for (j = 0; j < queue.length; j++)
      queue[j].destroy();
  }

  this.emit('close');
};

/**
 * Write data to the peer's socket.
 * @param {Buffer} data
 * @returns {Boolean}
 */

Peer.prototype.write = function write(data) {
  if (this.destroyed)
    return false;

  this.lastSend = utils.ms();

  return this.socket.write(data);
};

/**
 * Send a packet.
 * @param {Packet} packet
 */

Peer.prototype.send = function send(packet) {
  var tx, checksum;

  // Used cached hashes as the
  // packet checksum for speed.
  if (packet.type === packetTypes.TX) {
    tx = packet.tx;
    if (packet.witness) {
      if (!tx.isCoinbase())
        checksum = tx.witnessHash();
    } else {
      checksum = tx.hash();
    }
  }

  this.write(this.framer.packet(packet.cmd, packet.toRaw(), checksum));
};

/**
 * Emit an error and destroy the peer.
 * @private
 * @param {...String|Error} err
 */

Peer.prototype.error = function error(err, keep) {
  var i, args, msg;

  if (this.destroyed)
    return;

  if (typeof err === 'string') {
    args = new Array(arguments.length);

    for (i = 0; i < args.length; i++)
      args[i] = arguments[i];

    if (typeof args[args.length - 1] === 'boolean')
      keep = args.pop();

    msg = utils.fmt.apply(utils, args);
    err = new Error(msg);
  }

  err.message += ' (' + this.hostname + ')';

  if (!keep)
    this.destroy();

  this.emit('error', err);
};

/**
 * Wait for a packet to be received from peer.
 * @private
 * @param {String} cmd - Packet name.
 * @param {Function} callback - Returns [Error, Object(payload)].
 * Executed on timeout or once packet is received.
 */

Peer.prototype.request = function request(cmd, callback) {
  var entry;

  if (this.destroyed)
    return callback(new Error('Destroyed'));

  entry = new RequestEntry(this, cmd, callback);

  if (!this.requestMap[cmd])
    this.requestMap[cmd] = [];

  this.requestMap[cmd].push(entry);

  return entry;
};

/**
 * Fulfill awaiting requests created with {@link Peer#request}.
 * @private
 * @param {String} cmd - Packet name.
 * @param {Object} payload
 */

Peer.prototype.response = function response(cmd, payload) {
  var queue = this.requestMap[cmd];
  var entry, res;

  if (!queue)
    return false;

  entry = queue[0];

  if (!entry)
    return false;

  res = entry.callback(null, payload, cmd);

  if (res === false)
    return false;

  queue.shift();

  if (queue.length === 0)
    delete this.requestMap[cmd];

  entry.destroy();

  return true;
};

/**
 * Send `getdata` to peer.
 * @param {InvItem[]} items
 */

Peer.prototype.getData = function getData(items) {
  var data = new Array(items.length);
  var i, item;

  for (i = 0; i < items.length; i++) {
    item = items[i];

    if (item.toInv)
      item = item.toInv();

    if (this.options.compact
        && this.compactMode
        && item.isBlock()
        && !item.hasWitness()) {
      item.type = constants.inv.CMPCT_BLOCK;
    }

    data[i] = item;
  }

  this.send(new packets.GetDataPacket(data));
};

/**
 * Handle a packet payload.
 * @private
 * @param {Packet} packet
 */

Peer.prototype._onPacket = function onPacket(packet) {
  this.lastRecv = utils.ms();

  if (this.bip151
      && !this.bip151.completed
      && packet.type !== packetTypes.ENCINIT
      && packet.type !== packetTypes.ENCACK) {
    this.bip151.complete(new Error('Message before handshake.'));
  }

  if (this.bip150
      && !this.bip150.completed
      && packet.type !== packetTypes.AUTHCHALLENGE
      && packet.type !== packetTypes.AUTHREPLY
      && packet.type !== packetTypes.AUTHPROPOSE) {
    this.bip150.complete(new Error('Message before auth.'));
  }

  if (this.lastBlock) {
    if (packet.type !== packetTypes.TX)
      this._flushMerkle();
  }

  switch (packet.type) {
    case packetTypes.VERSION:
      return this._handleVersion(packet);
    case packetTypes.VERACK:
      return this._handleVerack(packet);
    case packetTypes.PING:
      return this._handlePing(packet);
    case packetTypes.PONG:
      return this._handlePong(packet);
    case packetTypes.ALERT:
      return this._handleAlert(packet);
    case packetTypes.GETADDR:
      return this._handleGetAddr(packet);
    case packetTypes.ADDR:
      return this._handleAddr(packet);
    case packetTypes.INV:
      return this._handleInv(packet);
    case packetTypes.GETDATA:
      return this._handleGetData(packet);
    case packetTypes.NOTFOUND:
      return this._handleNotFound(packet);
    case packetTypes.GETBLOCKS:
      return this._handleGetBlocks(packet);
    case packetTypes.GETHEADERS:
      return this._handleGetHeaders(packet);
    case packetTypes.HEADERS:
      return this._handleHeaders(packet);
    case packetTypes.SENDHEADERS:
      return this._handleSendHeaders(packet);
    case packetTypes.BLOCK:
      return this._handleBlock(packet);
    case packetTypes.TX:
      return this._handleTX(packet);
    case packetTypes.REJECT:
      return this._handleReject(packet);
    case packetTypes.MEMPOOL:
      return this._handleMempool(packet);
    case packetTypes.FILTERLOAD:
      return this._handleFilterLoad(packet);
    case packetTypes.FILTERADD:
      return this._handleFilterAdd(packet);
    case packetTypes.FILTERCLEAR:
      return this._handleFilterClear(packet);
    case packetTypes.MERKLEBLOCK:
      return this._handleMerkleBlock(packet);
    case packetTypes.GETUTXOS:
      return this._handleGetUTXOs(packet);
    case packetTypes.UTXOS:
      return this._handleUTXOs(packet);
    case packetTypes.HAVEWITNESS:
      return this._handleHaveWitness(packet);
    case packetTypes.FEEFILTER:
      return this._handleFeeFilter(packet);
    case packetTypes.SENDCMPCT:
      return this._handleSendCmpct(packet);
    case packetTypes.CMPCTBLOCK:
      return this._handleCmpctBlock(packet);
    case packetTypes.GETBLOCKTXN:
      return this._handleGetBlockTxn(packet);
    case packetTypes.BLOCKTXN:
      return this._handleBlockTxn(packet);
    case packetTypes.ENCINIT:
      return this._handleEncinit(packet);
    case packetTypes.ENCACK:
      return this._handleEncack(packet);
    case packetTypes.AUTHCHALLENGE:
      return this._handleAuthChallenge(packet);
    case packetTypes.AUTHREPLY:
      return this._handleAuthReply(packet);
    case packetTypes.AUTHPROPOSE:
      return this._handleAuthPropose(packet);
    case packetTypes.UNKNOWN:
      return this._handleUnknown(packet);
    default:
      assert(false, 'Bad packet type.');
      break;
  }
};

/**
 * Flush merkle block once all matched
 * txs have been received.
 * @private
 */

Peer.prototype._flushMerkle = function _flushMerkle() {
  if (this.lastBlock)
    this.fire('merkleblock', this.lastBlock);
  this.lastBlock = null;
  this.waiting = 0;
};

/**
 * Emit an event and fulfill a response.
 * @param {String} cmd
 * @param {Object} payload
 */

Peer.prototype.fire = function fire(cmd, payload) {
  this.response(cmd, payload);
  this.emit(cmd, payload);
};

/**
 * Handle `filterload` packet.
 * @private
 * @param {FilterLoadPacket}
 */

Peer.prototype._handleFilterLoad = function _handleFilterLoad(packet) {
  if (!packet.isWithinConstraints()) {
    this.setMisbehavior(100);
    return;
  }

  this.spvFilter = packet.toFilter();
  this.relay = true;
};

/**
 * Handle `filteradd` packet.
 * @private
 * @param {FilterAddPacket}
 */

Peer.prototype._handleFilterAdd = function _handleFilterAdd(packet) {
  var data = packet.data;

  if (data.length > constants.script.MAX_PUSH) {
    this.setMisbehavior(100);
    return;
  }

  if (this.spvFilter)
    this.spvFilter.add(data);

  this.relay = true;
};

/**
 * Handle `filterclear` packet.
 * @private
 * @param {FilterClearPacket}
 */

Peer.prototype._handleFilterClear = function _handleFilterClear(packet) {
  if (this.spvFilter)
    this.spvFilter.reset();

  this.relay = true;
};

/**
 * Handle `merkleblock` packet.
 * @private
 * @param {MerkleBlockPacket}
 */

Peer.prototype._handleMerkleBlock = function _handleMerkleBlock(packet) {
  var block = packet.block;

  block.verifyPartial();

  this.lastBlock = block;
  this.waiting = block.matches.length;

  if (this.waiting === 0)
    this._flushMerkle();
};

/**
 * Handle `feefilter` packet.
 * @private
 * @param {FeeFilterPacket}
 */

Peer.prototype._handleFeeFilter = function _handleFeeFilter(packet) {
  var rate = packet.rate;

  if (!(rate >= 0 && rate <= constants.MAX_MONEY)) {
    this.setMisbehavior(100);
    return;
  }

  this.feeRate = rate;

  this.fire('feefilter', rate);
};

/**
 * Handle `utxos` packet.
 * @private
 * @param {UTXOsPacket}
 */

Peer.prototype._handleUTXOs = function _handleUTXOs(utxos) {
  this.logger.debug('Received %d utxos (%s).',
    utxos.coins.length, this.hostname);
  this.fire('utxos', utxos);
};

/**
 * Handle `getutxos` packet.
 * @private
 */

Peer.prototype._handleGetUTXOs = function _handleGetUTXOs(packet) {
  var self = this;
  var unlock = this._lock(_handleGetUTXOs, [packet, utils.nop]);
  var utxos;

  if (!unlock)
    return;

  function done(err) {
    if (err) {
      self.emit('error', err);
      return unlock();
    }
    unlock();
  }

  if (!this.chain.synced)
    return done();

  if (this.options.selfish)
    return done();

  if (this.chain.db.options.spv)
    return done();

  if (packet.prevout.length > 15)
    return done();

  utxos = new packets.GetUTXOsPacket();

  utils.forEachSerial(packet.prevout, function(prevout, next) {
    var hash = prevout.hash;
    var index = prevout.index;
    var coin;

    if (self.mempool && packet.mempool) {
      coin = self.mempool.getCoin(hash, index);

      if (coin) {
        utxos.hits.push(1);
        utxos.coins.push(coin);
        return next();
      }

      if (self.mempool.isSpent(hash, index)) {
        utxos.hits.push(0);
        return next();
      }
    }

    self.chain.db.getCoin(hash, index, function(err, coin) {
      if (err)
        return next(err);

      if (!coin) {
        utxos.hits.push(0);
        return next();
      }

      utxos.hits.push(1);
      utxos.coins.push(coin);

      next();
    });
  }, function(err) {
    if (err)
      return done(err);

    utxos.height = self.chain.height;
    utxos.tip = self.chain.tip.hash;

    self.send(utxos);

    done();
  });
};

/**
 * Handle `havewitness` packet.
 * @private
 * @param {HaveWitnessPacket}
 */

Peer.prototype._handleHaveWitness = function _handleHaveWitness(packet) {
  this.haveWitness = true;
  this.fire('havewitness');
};

/**
 * Handle `getheaders` packet.
 * @private
 * @param {GetHeadersPacket}
 */

Peer.prototype._handleGetHeaders = function _handleGetHeaders(packet) {
  var self = this;
  var headers = [];
  var unlock = this._lock(_handleGetHeaders, [packet, utils.nop]);

  if (!unlock)
    return;

  function done(err) {
    if (err) {
      self.emit('error', err);
      return unlock();
    }
    self.sendHeaders(headers);
    unlock();
  }

  if (!this.chain.synced)
    return done();

  if (this.options.selfish)
    return done();

  if (this.chain.db.options.spv)
    return done();

  if (this.chain.db.options.prune)
    return done();

  function collect(err, hash) {
    if (err)
      return done(err);

    if (!hash)
      return done();

    self.chain.db.get(hash, function(err, entry) {
      if (err)
        return done(err);

      if (!entry)
        return done();

      (function next(err, entry) {
        if (err)
          return done(err);

        if (!entry)
          return done();

        headers.push(entry.toHeaders());

        if (headers.length === 2000)
          return done();

        if (entry.hash === packet.stop)
          return done();

        entry.getNext(next);
      })(null, entry);
    });
  }

  if (packet.locator.length === 0)
    return collect(null, packet.stop);

  this.chain.findLocator(packet.locator, function(err, hash) {
    if (err)
      return collect(err);

    if (!hash)
      return collect();

    self.chain.db.getNextHash(hash, collect);
  });
};

/**
 * Handle `getblocks` packet.
 * @private
 * @param {GetBlocksPacket}
 */

Peer.prototype._handleGetBlocks = function _handleGetBlocks(packet) {
  var self = this;
  var blocks = [];
  var unlock = this._lock(_handleGetBlocks, [packet, utils.nop]);

  if (!unlock)
    return;

  function done(err) {
    if (err) {
      self.emit('error', err);
      return unlock();
    }
    self.sendInv(blocks);
    unlock();
  }

  if (!this.chain.synced)
    return done();

  if (this.options.selfish)
    return done();

  if (this.chain.db.options.spv)
    return done();

  if (this.chain.db.options.prune)
    return done();

  this.chain.findLocator(packet.locator, function(err, tip) {
    if (err)
      return done(err);

    if (!tip)
      return done();

    (function next(hash) {
      self.chain.db.getNextHash(hash, function(err, hash) {
        if (err)
          return done(err);

        if (!hash)
          return done();

        blocks.push(new InvItem(constants.inv.BLOCK, hash));

        if (hash === packet.stop)
          return done();

        if (blocks.length === 500) {
          self.hashContinue = hash;
          return done();
        }

        next(hash);
      });
    })(tip);
  });
};

/**
 * Handle `version` packet.
 * @private
 * @param {VersionPacket}
 */

Peer.prototype._handleVersion = function _handleVersion(version) {
  var self = this;

  if (!this.network.selfConnect) {
    if (version.nonce.cmp(this.pool.localNonce) === 0) {
      this.error('We connected to ourself. Oops.');
      this.ignore();
      return;
    }
  }

  if (version.version < constants.MIN_VERSION) {
    this.error('Peer does not support required protocol version.');
    this.ignore();
    return;
  }

  if (this.outbound) {
    if (!version.hasNetwork()) {
      this.error('Peer does not support network services.');
      this.ignore();
      return;
    }
  }

  if (this.options.headers) {
    if (!version.hasHeaders()) {
      this.error('Peer does not support getheaders.');
      this.ignore();
      return;
    }
  }

  if (this.options.spv) {
    if (!version.hasBloom()) {
      this.error('Peer does not support BIP37.');
      this.ignore();
      return;
    }
  }

  if (this.options.witness) {
    if (!version.hasWitness()) {
      if (!this.network.oldWitness) {
        this.error('Peer does not support segregated witness.');
        this.ignore();
        return;
      }
      return this.request('havewitness', function(err) {
        if (err) {
          self.error('Peer does not support segregated witness.');
          self.ignore();
          return;
        }
        self._finishVersion(version);
      });
    }
  }

  this._finishVersion(version);
};

/**
 * Finish handling `version` packet.
 * @private
 * @param {VersionPacket}
 */

Peer.prototype._finishVersion = function _finishVersion(version) {
  if (version.hasWitness())
    this.haveWitness = true;

  if (!version.relay)
    this.relay = false;

  this.send(new packets.VerackPacket());
  this.version = version;
  this.fire('version', version);
};

/**
 * Handle `verack` packet.
 * @private
 * @param {VerackPacket}
 */

Peer.prototype._handleVerack = function _handleVerack(packet) {
  this.fire('verack');
};

/**
 * Handle `mempool` packet.
 * @private
 * @param {MempoolPacket}
 */

Peer.prototype._handleMempool = function _handleMempool(packet) {
  var self = this;
  var items = [];
  var i, hashes;
  var unlock = this._lock(_handleMempool, [packet, utils.nop]);

  if (!unlock)
    return;

  function done(err) {
    if (err) {
      self.emit('error', err);
      return unlock();
    }
    unlock();
  }

  if (!this.mempool)
    return done();

  if (!this.chain.synced)
    return done();

  if (this.options.selfish)
    return done();

  hashes = this.mempool.getSnapshot();

  for (i = 0; i < hashes.length; i++)
    items.push(new InvItem(constants.inv.TX, hashes[i]));

  self.logger.debug('Sending mempool snapshot (%s).', self.hostname);

  self.sendInv(items);
};

/**
 * Get a block/tx either from the broadcast map, mempool, or blockchain.
 * @param {InvItem} item
 * @param {Function} callback - Returns
 * [Error, {@link Block}|{@link MempoolEntry}].
 */

Peer.prototype._getItem = function _getItem(item, callback) {
  var entry = this.pool.invMap[item.hash];

  if (entry) {
    this.logger.debug(
      'Peer requested %s %s as a %s packet (%s).',
      entry.type === constants.inv.TX ? 'tx' : 'block',
      utils.revHex(entry.hash),
      item.hasWitness() ? 'witness' : 'normal',
      this.hostname);

    entry.ack(this);

    if (entry.msg) {
      if (item.isTX()) {
        if (entry.type === constants.inv.TX)
          return callback(null, entry.msg);
      } else {
        if (entry.type === constants.inv.BLOCK)
          return callback(null, entry.msg);
      }
      return callback();
    }
  }

  if (this.options.selfish)
    return callback();

  if (item.isTX()) {
    if (!this.mempool)
      return callback();
    return callback(null, this.mempool.getTX(item.hash));
  }

  if (this.chain.db.options.spv)
    return callback();

  if (this.chain.db.options.prune)
    return callback();

  this.chain.db.getBlock(item.hash, callback);
};

/**
 * Handle `getdata` packet.
 * @private
 * @param {GetDataPacket}
 */

Peer.prototype._handleGetData = function _handleGetData(packet) {
  var self = this;
  var notFound = [];
  var items = packet.items;
  var unlock = this._lock(_handleGetData, [packet, utils.nop]);

  if (!unlock)
    return;

  function done(err) {
    if (err) {
      self.emit('error', err);
      return unlock();
    }
    unlock();
  }

  if (items.length > 50000) {
    this.error('getdata size too large (%s).', items.length);
    return done();
  }

  utils.forEachSerial(items, function(item, next) {
    var i, tx, block;

    self._getItem(item, function(err, entry) {
      if (err)
        return next(err);

      if (!entry) {
        notFound.push(item);
        return next();
      }

      if (item.isTX()) {
        tx = entry;

        // Coinbases are an insta-ban from any node.
        // This should technically never happen, but
        // it's worth keeping here just in case. A
        // 24-hour ban from any node is rough.
        if (tx.isCoinbase()) {
          notFound.push(item);
          self.logger.warning('Failsafe: tried to relay a coinbase.');
          return next();
        }

        self.send(new packets.TXPacket(tx, item.hasWitness()));

        return next();
      }

      block = entry;

      switch (item.type) {
        case constants.inv.BLOCK:
        case constants.inv.WITNESS_BLOCK:
          self.send(new packets.BlockPacket(block, item.hasWitness()));
          break;
        case constants.inv.FILTERED_BLOCK:
        case constants.inv.WITNESS_FILTERED_BLOCK:
          if (!self.spvFilter) {
            notFound.push(item);
            return next();
          }

          block = block.toMerkle(self.spvFilter);

          self.send(new packets.MerkleBlockPacket(block));

          for (i = 0; i < block.txs.length; i++) {
            tx = block.txs[i];
            self.send(new packets.TXPacket(tx, item.hasWitness()));
          }

          break;
        case constants.inv.CMPCT_BLOCK:
          // Fallback to full block.
          if (block.height < self.chain.tip.height - 10) {
            self.send(new packets.BlockPacket(block, false));
            break;
          }

          // Try again with a new nonce
          // if we get a siphash collision.
          for (;;) {
            try {
              block = bcoin.bip152.CompactBlock.fromBlock(block);
            } catch (e) {
              continue;
            }
            break;
          }

          self.send(new packets.CmpctBlockPacket(block, false));
          break;
        default:
          self.logger.warning(
            'Peer sent an unknown getdata type: %s (%s).',
            item.type,
            self.hostname);
          notFound.push(item);
          return next();
      }

      if (item.hash === self.hashContinue) {
        self.sendInv(new InvItem(constants.inv.BLOCK, self.chain.tip.hash));
        self.hashContinue = null;
      }

      next();
    });
  }, function(err) {
    if (err)
      return done(err);

    self.logger.debug(
      'Served %d items with getdata (notfound=%d) (%s).',
      items.length - notFound.length,
      notFound.length,
      self.hostname);

    if (notFound.length > 0)
      self.send(new packets.NotFoundPacket(notFound));

    done();
  });
};

/**
 * Handle `notfound` packet.
 * @private
 * @param {NotFoundPacket}
 */

Peer.prototype._handleNotFound = function _handleNotFound(packet) {
  this.fire('notfound', packet.items);
};

/**
 * Handle `addr` packet.
 * @private
 * @param {AddrPacket}
 */

Peer.prototype._handleAddr = function _handleAddr(packet) {
  var addrs = packet.items;
  var i;

  for (i = 0; i < addrs.length; i++)
    this.addrFilter.add(addrs[i].host, 'ascii');

  this.logger.info(
    'Received %d addrs (hosts=%d, peers=%d) (%s).',
    addrs.length,
    this.pool.hosts.items.length,
    this.pool.peers.all.length,
    this.hostname);

  this.fire('addr', addrs);
};

/**
 * Handle `ping` packet.
 * @private
 * @param {PingPacket}
 */

Peer.prototype._handlePing = function _handlePing(packet) {
  if (packet.nonce)
    this.send(new packets.PongPacket(packet.nonce));
  this.fire('ping', this.minPing);
};

/**
 * Handle `pong` packet.
 * @private
 * @param {PongPacket}
 */

Peer.prototype._handlePong = function _handlePong(packet) {
  var nonce = packet.nonce;
  var now = utils.ms();

  if (!this.challenge) {
    this.logger.debug('Peer sent an unsolicited pong (%s).', this.hostname);
    return;
  }

  if (nonce.cmp(this.challenge) !== 0) {
    if (nonce.cmpn(0) === 0) {
      this.logger.debug('Peer sent a zero nonce (%s).', this.hostname);
      this.challenge = null;
      return;
    }
    this.logger.debug('Peer sent the wrong nonce (%s).', this.hostname);
    return;
  }

  if (now >= this.lastPing) {
    this.lastPong = now;
    if (this.minPing === -1)
      this.minPing = now - this.lastPing;
    this.minPing = Math.min(this.minPing, now - this.lastPing);
  } else {
    this.logger.debug('Timing mismatch (what?) (%s).', this.hostname);
  }

  this.challenge = null;

  this.fire('pong', this.minPing);
};

/**
 * Handle `getaddr` packet.
 * @private
 * @param {GetAddrPacket}
 */

Peer.prototype._handleGetAddr = function _handleGetAddr(packet) {
  var items = [];
  var i, addr;

  if (this.options.selfish)
    return;

  if (this.sentAddr) {
    this.logger.debug('Ignoring repeated getaddr (%s).', this.hostname);
    return;
  }

  this.sentAddr = true;

  for (i = 0; i < this.pool.hosts.items.length; i++) {
    addr = this.pool.hosts.items[i];

    if (!addr.isIP())
      continue;

    if (!this.addrFilter.added(addr.host, 'ascii'))
      continue;

    items.push(addr);

    if (items.length === 1000)
      break;
  }

  if (items.length === 0)
    return;

  this.logger.debug(
    'Sending %d addrs to peer (%s)',
    items.length,
    this.hostname);

  this.send(new packets.AddrPacket(items));
};

/**
 * Handle `inv` packet.
 * @private
 * @param {InvPacket}
 */

Peer.prototype._handleInv = function _handleInv(packet) {
  var items = packet.items;
  var blocks = [];
  var txs = [];
  var unknown = -1;
  var i, item;

  if (items.length > 50000) {
    this.setMisbehavior(100);
    return;
  }

  for (i = 0; i < items.length; i++) {
    item = items[i];
    switch (item.type) {
      case constants.inv.TX:
        txs.push(item.hash);
        break;
      case constants.inv.BLOCK:
        blocks.push(item.hash);
        break;
      default:
        unknown = item.type;
        continue;
    }
    this.invFilter.add(item.hash, 'hex');
  }

  this.fire('inv', items);

  if (blocks.length > 0)
    this.emit('blocks', blocks);

  if (txs.length > 0)
    this.emit('txs', txs);

  if (unknown !== -1) {
    this.logger.warning(
      'Peer sent an unknown inv type: %d (%s).',
      unknown, this.hostname);
  }
};

/**
 * Handle `headers` packet.
 * @private
 * @param {HeadersPacket}
 */

Peer.prototype._handleHeaders = function _handleHeaders(packet) {
  var headers = packet.items;

  if (headers.length > 2000) {
    this.setMisbehavior(100);
    return;
  }

  this.fire('headers', headers);
};

/**
 * Handle `sendheaders` packet.
 * @private
 * @param {SendHeadersPacket}
 */

Peer.prototype._handleSendHeaders = function _handleSendHeaders(packet) {
  this.preferHeaders = true;
  this.fire('sendheaders');
};

/**
 * Handle `block` packet.
 * @private
 * @param {BlockPacket}
 */

Peer.prototype._handleBlock = function _handleBlock(packet) {
  this.fire('block', packet.block);
};

/**
 * Handle `tx` packet.
 * @private
 * @param {TXPacket}
 */

Peer.prototype._handleTX = function _handleTX(packet) {
  var tx = packet.tx;

  if (this.lastBlock) {
    if (this.lastBlock.hasTX(tx)) {
      this.lastBlock.addTX(tx);
      if (--this.waiting === 0)
        this._flushMerkle();
      return;
    }
  }

  this.fire('tx', tx);
};

/**
 * Handle `reject` packet.
 * @private
 * @param {RejectPacket}
 */

Peer.prototype._handleReject = function _handleReject(details) {
  var hash, entry;

  this.fire('reject', details);

  if (!details.data)
    return;

  hash = details.data;
  entry = this.pool.invMap[hash];

  if (!entry)
    return;

  entry.reject(this);
};

/**
 * Handle `alert` packet.
 * @private
 * @param {AlertPacket}
 */

Peer.prototype._handleAlert = function _handleAlert(alert) {
  this.invFilter.add(alert.hash());
  this.fire('alert', alert);
};

/**
 * Handle `encinit` packet.
 * @private
 * @param {EncinitPacket}
 */

Peer.prototype._handleEncinit = function _handleEncinit(packet) {
  if (!this.bip151)
    return;

  try {
    this.bip151.encinit(packet.publicKey, packet.cipher);
  } catch (e) {
    this.error(e);
    return;
  }

  this.send(this.bip151.toEncack());

  this.fire('encinit', packet);
};

/**
 * Handle `encack` packet.
 * @private
 * @param {EncackPacket}
 */

Peer.prototype._handleEncack = function _handleEncack(packet) {
  if (!this.bip151)
    return;

  try {
    this.bip151.encack(packet.publicKey);
  } catch (e) {
    this.error(e);
    return;
  }

  this.fire('encack', packet);
};

/**
 * Handle `authchallenge` packet.
 * @private
 * @param {AuthChallengePacket}
 */

Peer.prototype._handleAuthChallenge = function _handleAuthChallenge(packet) {
  var sig;

  if (!this.bip150)
    return;

  try {
    sig = this.bip150.challenge(packet.hash);
  } catch (e) {
    this.error(e);
    return;
  }

  this.send(new packets.AuthReplyPacket(sig));

  this.fire('authchallenge', packet.hash);
};

/**
 * Handle `authreply` packet.
 * @private
 * @param {AuthReplyPacket}
 */

Peer.prototype._handleAuthReply = function _handleAuthReply(packet) {
  var hash;

  if (!this.bip150)
    return;

  try {
    hash = this.bip150.reply(packet.signature);
  } catch (e) {
    this.error(e);
    return;
  }

  if (hash)
    this.send(new packets.AuthProposePacket(hash));

  this.fire('authreply', packet.signature);
};

/**
 * Handle `authpropose` packet.
 * @private
 * @param {AuthProposePacket}
 */

Peer.prototype._handleAuthPropose = function _handleAuthPropose(packet) {
  var hash;

  if (!this.bip150)
    return;

  try {
    hash = this.bip150.propose(packet.hash);
  } catch (e) {
    this.error(e);
    return;
  }

  this.send(new packets.AuthChallengePacket(hash));

  this.fire('authpropose', packet.hash);
};

/**
 * Handle an unknown packet.
 * @private
 * @param {UnknownPacket}
 */

Peer.prototype._handleUnknown = function _handleUnknown(packet) {
  this.logger.warning('Unknown packet: %s.', packet.cmd);
  this.fire('unknown', packet);
};

/**
 * Handle `sendcmpct` packet.
 * @private
 * @param {SendCmpctPacket}
 */

Peer.prototype._handleSendCmpct = function _handleSendCmpct(packet) {
  if (packet.version !== 1) {
    // Ignore
    this.logger.info('Peer request compact blocks version %d (%s).',
      packet.version, this.hostname);
    return;
  }

  if (packet.mode !== 0) {
    // Ignore (we can't do mode 1 yet).
    this.logger.info('Peer request compact blocks mode %d (%s).',
      packet.mode, this.hostname);
    return;
  }

  this.logger.info('Peer initialized compact blocks (%s).', this.hostname);

  this.compactMode = packet;
  this.fire('sendcmpct', packet);
};

/**
 * Handle `cmpctblock` packet.
 * @private
 * @param {CmpctBlockPacket}
 */

Peer.prototype._handleCmpctBlock = function _handleCmpctBlock(packet) {
  var self = this;
  var block = packet.block;
  var hash = block.hash('hex');
  var result;

  if (!this.options.compact) {
    this.logger.info('Peer sent unsolicited cmpctblock (%s).', this.hostname);
    return;
  }

  if (!this.mempool) {
    this.logger.warning('Requesting compact blocks without a mempool!');
    return;
  }

  if (this.compactBlocks[hash]) {
    this.logger.debug(
      'Peer sent us a duplicate compact block (%s).',
      this.hostname);
    return;
  }

  // Sort of a lock too.
  this.compactBlocks[hash] = block;

  result = block.fillMempool(this.mempool);

  if (result) {
    delete this.compactBlocks[hash];
    this.fire('block', block.toBlock());
    this.logger.debug(
      'Received full compact block %s (%s).',
      block.rhash, this.hostname);
    return;
  }

  this.send(new packets.GetBlockTxnPacket(block.toRequest()));

  this.logger.debug(
    'Received semi-full compact block %s (%s).',
    block.rhash, this.hostname);

  block.startTimeout(10000, function() {
    self.logger.debug(
      'Compact block timed out: %s (%s).',
      block.rhash, self.hostname);
    delete self.compactBlocks[hash];
  });
};

/**
 * Handle `getblocktxn` packet.
 * @private
 * @param {GetBlockTxnPacket}
 */

Peer.prototype._handleGetBlockTxn = function _handleGetBlockTxn(packet) {
  var self = this;
  var req = packet.request;
  var res, item;

  function done(err) {
    if (err) {
      self.emit('error', err);
      return;
    }
    self.fire('blocktxn', req);
  }

  if (this.chain.db.options.spv)
    return done();

  if (this.chain.db.options.prune)
    return done();

  if (this.options.selfish)
    return done();

  item = new InvItem(constants.inv.BLOCK, req.hash);

  this._getItem(item, function(err, block) {
    if (err)
      return done(err);

    if (!block) {
      self.logger.debug(
        'Peer sent getblocktxn for non-existent block (%s).',
        self.hostname);
      self.setMisbehavior(100);
      return done();
    }

    if (block.height < self.chain.tip.height - 15) {
      self.logger.debug(
        'Peer sent a getblocktxn for a block > 15 deep (%s)',
        self.hostname);
      return done();
    }

    res = bcoin.bip152.TXResponse.fromBlock(block, req);

    self.send(new packets.BlockTxnPacket(res, false));

    done();
  });
};

/**
 * Handle `blocktxn` packet.
 * @private
 * @param {BlockTxnPacket}
 */

Peer.prototype._handleBlockTxn = function _handleBlockTxn(packet) {
  var res = packet.response;
  var block = this.compactBlocks[res.hash];

  if (!block) {
    this.logger.debug('Peer sent unsolicited blocktxn (%s).', this.hostname);
    return;
  }

  this.fire('getblocktxn', res);

  block.stopTimeout();
  delete this.compactBlocks[res.hash];

  if (!block.fillMissing(res)) {
    this.setMisbehavior(100);
    this.logger.warning('Peer sent non-full blocktxn (%s).', this.hostname);
    return;
  }

  this.logger.debug(
    'Filled compact block %s (%s).',
    block.rhash, this.hostname);

  this.fire('block', block.toBlock());
};

/**
 * Send an `alert` to peer.
 * @param {AlertPacket} alert
 */

Peer.prototype.sendAlert = function sendAlert(alert) {
  if (!this.invFilter.added(alert.hash()))
    return;

  this.send(alert);
};

/**
 * Send `getheaders` to peer. Note that unlike
 * `getblocks`, `getheaders` can have a null locator.
 * @param {Hash[]?} locator - Chain locator.
 * @param {Hash?} stop - Hash to stop at.
 */

Peer.prototype.sendGetHeaders = function sendGetHeaders(locator, stop) {
  var packet = new packets.GetHeadersPacket(locator, stop);
  var height = -1;
  var hash = null;

  this.logger.debug(
    'Requesting headers packet from peer with getheaders (%s).',
    this.hostname);

  if (packet.locator.length > 0) {
    height = this.chain._getCachedHeight(packet.locator[0]);
    hash = utils.revHex(packet.locator[0]);
  }

  if (stop)
    stop = utils.revHex(stop);

  this.logger.debug('Height: %d, Hash: %s, Stop: %s', height, hash, stop);

  this.send(packet);
};

/**
 * Send `getblocks` to peer.
 * @param {Hash[]} locator - Chain locator.
 * @param {Hash?} stop - Hash to stop at.
 */

Peer.prototype.sendGetBlocks = function getBlocks(locator, stop) {
  var packet = new packets.GetBlocksPacket(locator, stop);
  var height = -1;
  var hash = null;

  this.logger.debug(
    'Requesting inv packet from peer with getblocks (%s).',
    this.hostname);

  if (packet.locator.length > 0) {
    height = this.chain._getCachedHeight(packet.locator[0]);
    hash = utils.revHex(packet.locator[0]);
  }

  if (stop)
    stop = utils.revHex(stop);

  this.logger.debug('Height: %d, Hash: %s, Stop: %s', height, hash, stop);

  this.send(packet);
};

/**
 * Send `mempool` to peer.
 */

Peer.prototype.sendMempool = function sendMempool() {
  if (!this.version)
    return;

  if (!this.version.hasBloom()) {
    this.logger.debug(
      'Cannot request mempool for non-bloom peer (%s).',
      this.hostname);
    return;
  }

  this.logger.debug(
    'Requesting inv packet from peer with mempool (%s).',
    this.hostname);

  this.send(new packets.MempoolPacket());
};

/**
 * Send `reject` to peer.
 * @param {Number} code
 * @param {String} reason
 * @param {TX|Block} obj
 */

Peer.prototype.sendReject = function sendReject(code, reason, obj) {
  var reject = packets.RejectPacket.fromReason(code, reason, obj);

  if (obj) {
    this.logger.debug('Rejecting %s %s (%s): ccode=%s reason=%s.',
      reject.message, obj.rhash, this.hostname, code, reason);
  } else {
    this.logger.debug('Rejecting packet from %s: ccode=%s reason=%s.',
      this.hostname, code, reason);
  }

  this.logger.debug(
    'Sending reject packet to peer (%s).',
    this.hostname);

  this.send(reject);
};

/**
 * Send a `sendcmpct` packet.
 */

Peer.prototype.sendCompact = function sendCompact() {
  var cmpct = new packets.SendCmpctPacket(0, 1);
  this.logger.info('Initializing compact blocks (%s).', this.hostname);
  this.send(cmpct);
};

/**
 * Check whether the peer is misbehaving (banScore >= 100).
 * @returns {Boolean}
 */

Peer.prototype.isMisbehaving = function isMisbehaving() {
  return this.pool.hosts.isMisbehaving(this);
};

/**
 * Check whether the peer is ignored.
 * @returns {Boolean}
 */

Peer.prototype.isIgnored = function isIgnored() {
  return this.pool.hosts.isIgnored(this);
};

/**
 * Increase banscore on peer.
 * @param {Number} score
 */

Peer.prototype.setMisbehavior = function setMisbehavior(score) {
  return this.pool.setMisbehavior(this, score);
};

/**
 * Ignore peer.
 */

Peer.prototype.ignore = function ignore() {
  return this.pool.ignore(this);
};

/**
 * Send a `reject` packet to peer.
 * @see Framer.reject
 * @param {(TX|Block)?} obj
 * @param {String} code - cccode.
 * @param {String} reason
 * @param {Number} score
 */

Peer.prototype.reject = function reject(obj, code, reason, score) {
  this.sendReject(code, reason, obj);
  if (score > 0)
    this.setMisbehavior(score);
};

/**
 * Send `getblocks` to peer after building
 * locator and resolving orphan root.
 * @param {Hash} tip - Tip to build chain locator from.
 * @param {Hash} orphan - Orphan hash to resolve.
 * @param {Function} callback
 */

Peer.prototype.resolveOrphan = function resolveOrphan(tip, orphan, callback) {
  var self = this;
  var root;

  callback = utils.ensure(callback);

  assert(orphan);

  this.chain.getLocator(tip, function(err, locator) {
    if (err)
      return callback(err);

    root = self.chain.getOrphanRoot(orphan);

    // Was probably resolved.
    if (!root) {
      self.logger.debug('Orphan root was already resolved.');
      return callback();
    }

    self.sendGetBlocks(locator, root);

    callback();
  });
};

/**
 * Send `getheaders` to peer after building locator.
 * @param {Hash} tip - Tip to build chain locator from.
 * @param {Hash?} stop
 * @param {Function} callback
 */

Peer.prototype.getHeaders = function getHeaders(tip, stop, callback) {
  var self = this;

  callback = utils.ensure(callback);

  this.chain.getLocator(tip, function(err, locator) {
    if (err)
      return callback(err);

    self.sendGetHeaders(locator, stop);

    callback();
  });
};

/**
 * Send `getblocks` to peer after building locator.
 * @param {Hash} tip - Tip hash to build chain locator from.
 * @param {Hash?} stop
 * @param {Function} callback
 */

Peer.prototype.getBlocks = function getBlocks(tip, stop, callback) {
  var self = this;

  callback = utils.ensure(callback);

  this.chain.getLocator(tip, function(err, locator) {
    if (err)
      return callback(err);

    self.sendGetBlocks(locator, stop);

    callback();
  });
};

/**
 * Start syncing from peer.
 * @param {Function} callback
 */

Peer.prototype.sync = function sync(callback) {
  var tip;

  if (!this.pool.syncing)
    return;

  if (!this.ack)
    return;

  if (this.syncSent)
    return;

  if (!this.version.hasNetwork())
    return;

  if (!this.isLoader()) {
    if (!this.chain.synced)
      return;
  }

  // Ask for the mempool if we're synced.
  if (this.network.requestMempool) {
    if (this.isLoader() && this.chain.synced)
      this.sendMempool();
  }

  this.syncSent = true;

  if (this.options.headers) {
    if (!this.chain.tip.isGenesis())
      tip = this.chain.tip.prevBlock;

    return this.getHeaders(tip, null, callback);
  }

  this.getBlocks(null, null, callback);
};

/**
 * Inspect the peer.
 * @returns {String}
 */

Peer.prototype.inspect = function inspect() {
  return '<Peer:'
    + ' id=' + this.id
    + ' ack=' + this.ack
    + ' host=' + this.hostname
    + ' outbound=' + this.outbound
    + ' ping=' + this.minPing
    + '>';
};

/**
 * RequestEntry
 * @constructor
 */

function RequestEntry(peer, cmd, callback) {
  this.peer = peer;
  this.cmd = cmd;
  this.callback = callback;
  this.id = peer.uid++;
  this.onTimeout = this._onTimeout.bind(this);
  this.timeout = setTimeout(this.onTimeout, this.peer.requestTimeout);
}

RequestEntry.prototype._onTimeout = function _onTimeout() {
  var queue = this.peer.requestMap[this.cmd];

  if (!queue)
    return;

  if (utils.binaryRemove(queue, this, compare)) {
    if (queue.length === 0)
      delete this.peer.requestMap[this.cmd];
    this.callback(new Error('Timed out: ' + this.cmd));
  }
};

RequestEntry.prototype.destroy = function destroy() {
  if (this.timeout != null) {
    clearTimeout(this.timeout);
    this.timeout = null;
  }
};

/*
 * Helpers
 */

function compare(a, b) {
  return a.id - b.id;
}

/*
 * Expose
 */

module.exports = Peer;
