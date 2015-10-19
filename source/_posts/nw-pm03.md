title: "Building a Multiplayer Game with Node.js and Node-webkit: Networking in General"
date: 2014-12-20 03:57:36
tags:
permalink: building-multiplayer-game-nodejs-node-webkit-networking-general
---

In the [first part](/building-multiplayer-game-nodejs-node-webkit/) of this tutorial we've made a set of tools allowing us to implement client-side features in a simple and flexible way. This includes WebGL-based graphics, sound with Web Audio API, simple resource management and local storage support. In the [second part](/building-multiplayer-game-nodejs-node-webkit-tiles-sprites/) we've implemented a simple framework to work with sprite-based graphics. The next step is to start thinking about our game from the networked multiplayer perspective.

I've already decided to use UDP-based networking for this project but I think I should elaborate a bit about other options we have.

Firstly there is [AJAX](https://developer.mozilla.org/en-US/docs/AJAX). That's a great technique web developers use every day to make applications like GMail and Google Maps. The original idea was to use JavaScript to send HTTP requests to the server to get some data only when it's needed. E.g. to load an email content only when user wants to read this email without refreshing the web page. This is just a concept and there are multiple implementations of it (like JSONP, posting forms to iframes and such). The main conceptual limitation here is that AJAX support only client-to-server messages, not vice versa. Basically if you want to send something from server to client you need to "poll" the server from time to time. There are [some ways](http://en.wikipedia.org/wiki/Push_technology) to fight this limitation though. Another thing to note is that HTTP is a bit slow and have pretty huge overhead when compared to other techiques. My opinion is that you want to use AJAX for your game networking only if you want the game to be playable in old browsers and IE.

The next thing in the list is of course the [WebSockets](https://developer.mozilla.org/en-US/docs/WebSockets). That's basically a TCP sockets (see below) implementation for browsers. This tech performs a lot better than any HTTP-based solution and right now you want to use WebSockets to make most of your browser games that does not require peer-to-peer. There is also a very nice high-level library on top of WebSockets called [Socket.IO](http://socket.io/). Check this out if you wish to sacrifice some performance for better API (e.g. for game lobby, chatting etc). For peer-to-peer in browser there is a brand new technology called [WebRTC](https://developer.mozilla.org/en-US/docs/Web/Guide/API/WebRTC). It's very promising and I am looking forward to test it for myself. WebRTC even supports something like UDP (see below) so in the future we'll be using it all the time for fast-paced multiplayer in the browser.

Basically that's all we have if we are bound to the browser in our client-side implementation. But with node-webkit we also have access to UDP and TCP sockets (actually with node-webkit we have access to everything as we can extend Node.js with C++ but that's a bit off-topic).

<!--more-->

TCP and UDP
-----------
[TCP](http://en.wikipedia.org/wiki/Transmission_Control_Protocol) is a great and easy to use protocol where you just make a bidirectional connection between two machines over the network and have an ability to "write" data to the one end and "read" data from the other without loosing anything, perfectly in order and without duplicates. Just like reading and writing files. TCP does not provide a concept of "message" built-in so you need to manually encode messages and handle message separation and decoding on the receiving side. That's not a big deal though. 

[UDP](http://en.wikipedia.org/wiki/User_Datagram_Protocol) is a kind of more low-level protocol (closer to the underlying IP protocol) allowing you to just send a packet (binary message) to any network address (by specifying host and port). The "message" concept is built-in, but there is no concept of connection and it isn't garanteed that your packet will be received. In fact you can't even know if the packet was received or not. Even if everything is OK and host is reachable packets could be lost for any reason or may arive out of order and with duplicates. You won't get any partial packets though: it's everything or nothing. Last point also means that with UDP you need to manually control your packet size: you can't just pass 30 Kb packet to UDP and hope for the best like you always do with TCP.

From my experience you should use TCP for slow-paced or turn-based games where lags could be perfectly hidden from the player. TCP will simplify your networking layer and help you to get most throughput from players' internet connections. For more or less fast-paced realtime games (like shooters and racing) there are reasons why UDP is a lot better. Long story short: in realtime you want to have more control over your networking. If some packet is lost it's application's responsibility to decide what to do:

 - Maybe it's a critical game-changing message that should be there as soon as possible (e.g. user input). Then we need to resend it until it's received.
 - But what if it's just a message about position of other player in FPS-like? We don't need to resend it because it will be outdated after 50 ms anyway. We'll better send a brand new message with more up-to-date information instead.

Check out [this article](http://gafferongames.com/networking-for-game-programmers/udp-vs-tcp/) for more details. But as always don't believe anyone, just test it for yourself. For your application and users it may be better to just stick with TCP even if you build something fast. And, as I said, you only have TCP if you want your game to be playable in browsers.

The game I have in mind for this tutorial is slow-paced enough to use TCP but I also want it to have a "dumb" client (client that doesn't perform any sort of "prediction" of future game state). It's just a lot easier to think about and it's better from the software design standpoint. With such client quite common TCP lags of 250 ms will *always* result in application lags. With UDP I hope we'll manage to provide a lag-free experience.

Another reason behind using such relatively "hardcore" tech for this tutorial is just to make it more interesting and enlightening. That's pretty straightforward to roll JSON-over-WebSocket style networking prototype without even thinking about message formats, bandwidth allocation and such. I want to talk about more sophisticated but more rewarding approach.

Local Game Server
-----------------
For single-player mode, non-dedicated server support and more importantly for game developement process we need to be able to launch our game server locally from the client. The most obvious way is to just `require` the server from the client and start it in the same process (e.g. `require('../server').start(PORT)`). That's a perfectly acceptable way but with JavaScript incapability of multithreading it would be better performance-wise to launch it in the separated process. I [suppose](http://store.steampowered.com/hwsurvey/) most people have at least dual-core computer in 2014.

As I said before you need to vendorize (e.g. include into your game package) *both* node-webkit and Node.js executables. That's because there are [some issues](https://github.com/rogerwang/node-webkit/issues/213) with the current node-webkit version which renders `child_process.fork()` literally broken. I will update this tutorial when this issues are resolved. As a work-around right now we vendorize `node` and use `child_process.spawn()` to launch the server. Like so:

``` javascript client/server_process.js
var cp = require('child_process');

var child = null;

exports.start = function (port) {
    var platform = process.platform,
        exe = (platform == "win32" ? ".exe" : "");
    var root = process.cwd() + '/../../';
    var node = root + "bin/" + platform + "/node" + exe;
    child = cp.spawn(
        node, ["server", port], { cwd: root }
    );
    child.on("close", function (code) {
        throw new Error("Server process died with code: " + code);
    });
    if (require("./config").debug) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", function (chunk) {
            console.log("SERVER: " + chunk);
        });
    }
    child.unref();
};
```

Just to test that we have some connectivity we can implement a pretty basic client and server networking routine as follows:

``` javascript client
var dgram = require("dgram");

serverProcess.start(config.localServer.port);
var socket = dgram.createSocket("udp4");

socket.on("message", function (packet, remote) {
    console.log("got " + packet.toString("utf8")
        + " from " + remote.address + ":" + remote.port);
});

setInterval(function () {
    var buf = new Buffer("HELO", "utf8");
    socket.send(buf, 0, buf.length, config.localServer.port, "127.0.0.1");
}, 1000);
```

``` javascript server
var dgram = require("dgram");

var PORT = process.argv[2] | 0;
var socket = dgram.createSocket("udp4");

socket.on("message", function (packet, remote) {
    console.log("got " + packet.toString("utf8")
        + " from " + remote.address + ":" + remote.port);
    var buf = new Buffer("OLEH", "utf8");
    socket.send(buf, 0, buf.length, remote.port, remote.address);
});

socket.bind(PORT);
```

If everything is OK you should see a conversation log in your webkit console. Check out the [source code](https://github.com/vbo/node-webkit-mp-game-template/blob/2912ad1657e36e55044134e600fcf6029a8cf43a/client/index.js#L24-L36) at this point. I suggest you to play with it for some time: try to compose messages differently, try to deploy server to another machine and send some messages via LAN etc. The next step is to implement our network protocol on top of this raw UDP.

Implementing Network Protocol
-----------------------------
Designing your very own network protocol is a kind of art. Fortunately there are some nice and simple pre-designed protocols one of which we are going to implement. Check out [this](http://gafferongames.com/networking-for-game-programmers/virtual-connection-over-udp/) [two](http://gafferongames.com/networking-for-game-programmers/reliability-and-flow-control/) articles from Glenn Fiedler's blog to better understand what follows. We are not going to implement any kind of flow control right now. I leave it as an exercise for the reader.

Here is our protocol packet format in it's glory:

<img src="protocol.png"/>

Packet here represents a UDP packet we are willing to send to a particular peer (be it client or server). Packet header includes a kind of meta-information well-described in the Glenn Fiedler's article:
 - `protocol id` is just a randomly chosen integer constant for your game.
 - `sequence` is a sequence number of the packet. You increment it for each new packet sent.
 - `ack` is a sequence number of the newest packet received from the peer you are talking to. By sending a packet with `ack` of 100 you say that you successfully received a packet with `seq` 100 from this peer.
 - `acks bitfield` represents acks for 32 more packets. E.g. you received 100, 97 and all packets before 97. You use `ack` of 100 and `acks bitfield` like this: `0011111...`. First two zeros here say that you haven't received packets 99 and 98 yet.  
 - You want to also add a kind of `player id` here if you want to support strange routers constantly changing player's IP or port number.

Packet body can include zero or more messages of arbitrary length. In UDP packet length is limited by the network [MTU](http://en.wikipedia.org/wiki/Maximum_transmission_unit). You need to experiment with this a bit but if you are targeting casual PC users in 2014 you can safely assume 1400 MTU at least. From my experience it's OK to send packets of 1100 bytes. I also heard that Quake 3 limits UDP packages to 1300 bytes. Another limitation you want to take into account is player's network bandwidth but we'll talk about this later.

Glenn Fiedler have not specified message encoding so we are inventing a kind of wheel. You can treat this as something application specific but let's try to generalize when possible.

In my design each message has it's own message header:
 - `id` is a unique message identifier (e.g. we use it to drop duplicate messages).
 - `type` determines message type. E.g. you can use a type of `0` for time synch messages, `1` for map update and `2` for entity state update.
 
We'll use this `type` field to determine how to parse message body: e.g. for time synch we need to treat the whole message body as two tightly-packed floating point numbers representing client and server timestamps while for entity state update message (example message data colored in green) we need to carefully parse all of the entity parameters one by one. This is just an example, we'll talk about actual message types later in this tutorial.

Glenn's protocol assumes that we define connection as a steady bidirectional stream of packets. E.g. client connects to server and starts to send packets with some rate (like 20 packets per second). Client should send this packets even if it doesn't have any messages to include. When server receives the first packet from new IP address and port it takes a note that new client is connected. After that server also starts to send packets even if he has nothing to say to this client yet. If, for some reason, server doesn't receive packets from a particular client for e.g. 1 second he marks the client as "disconnected" and stop sending packets to him.

Minimal stream rate your game supports without lags and maximum packet size it uses together define a minimal requirement for client's network (so-called required bandwidth). For example if you have 500-byte packets and the rate of 20 packets per seconds (one packet in 50 milliseconds) you require 80kbps bandwidth (both upload and download). My opinion for 2014 is that we always have at least 256kbps on desktop. Here is a nice (and very optimistic) statistics about bandwidth limits for broadband and mobile links: [netindex.com](http://www.netindex.com/). Check this out but don't believe blindly.

When server application want to send some message it adds it to the message queue for a particular peer. When server wakes up to compose the next packet it can check that there are some messages in the queue and include some of them into the packet.

From the API design standpoint I like to have one `networking` package containing all this logic. It exports a `Connection` class that represent a connection to the network of peers. The only difference between client and server is that server wants to `listen` for new peer connections while client only wants to connect one peer - server - by specifying it's network address and port. Both client and server should configure `networking` library with userspace protocol implementation: a set of encoders and decoders for all known message types.

``` javascript client
var networking = require('../networking');
var protocol = require('../protocol');

var connection = networking.createConnection();
var server = connection.directConnect(ADDR, PORT);

setInterval(function () {
    server.send(new protocol.TextMessage("HELO"));
}, 1000);

server.on("message", function (msg) {
    if (msg instanceof protocol.TextMessage) {
        console.log("Got text message: " + msg.text);
    } else {
        console.log("Got " + (typeof msg) + "!", msg);
    }
});
```

``` javascript server
var networking = require('../networking');
var protocol = require('../protocol');

var connection = networking.createConnection();
connection.listen(PORT);

connection.on("listening", function () {
    console.log("Server is listening!", connection.listening);
});

connection.on("peer", function (peer) {
    console.log("New connection from " + peer.id);
    peer.on("message", function (msg) {
        if (msg instanceof protocol.TextMessage) {
            console.log("Got text message from " + peer.id + ": " + msg.text);
            peer.send(new protocol.TextMessage("OLEH"));
        } else {
            console.log("Got " + (typeof msg) + " from " + peer.id + "!", msg);
        }
    });
    peer.on("disconnect", function () {
        console.log(peer.id + " have been diconnected");
    });
});
```

``` javascript protocol
var networking = require("./networking");

var TextMessage = exports.TextMessage = function (text) {
    this.text = text;
};

TextMessage.prototype = new networking.Message();
TextMessage.prototype.typeid = 0;

TextMessage.prototype.encode = function () {
    if (!this._buffer) {
        var dataBuf = new Buffer(this.text, "utf8");
        var sizeBuf = new Buffer(4);
        sizeBuf.writeUInt32BE(dataBuf.length, 0);
        this._buffer = Buffer.concat([sizeBuf, dataBuf]);
    }
    return this._buffer;
};

TextMessage.decode = function (buf) {
    var size = buf.readUInt32BE(0);
    var index = 4 + size;
    var text = buf.toString("utf8", 4, index);
    return [new TextMessage(text), index];
};

for (var k in exports) {
    if (exports.hasOwnProperty(k)) {
        var type = exports[k];
        networking.registerMessageType(type);
    }
}
```

All of this `instanceof`ing is a bit ugly and message type code looks too verbose for such simple thing but we'll improve it later. For now just [study the source code](https://github.com/vbo/node-webkit-mp-game-template/tree/networking_1/networking) and let's start thinking about our application-specific message types. BTW this is actually my first attempt at implementing this protocol. I suspect lots of bugs here and there so I appreciate if you let me know of any issues you encounter.

