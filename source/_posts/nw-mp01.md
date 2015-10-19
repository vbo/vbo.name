title: "Building a Multiplayer Game with Node.js and Node-webkit: Toolset"
date: 2014-10-31 14:27:36
tags:
permalink: building-multiplayer-game-nodejs-node-webkit
---

[Node-webkit](https://github.com/rogerwang/node-webkit) seems like a very promising technology for implementing (or at least prototyping) multiplayer games. It gives us best from both worlds:
 - [Node.js](http://nodejs.org/) provides nice networking capabilities (like UDP support) and interfaces with OS. You also can extend Node.js by implementing addon in C/C++.
 - [Webkit](https://www.webkit.org/) handles multimedia (with HTML5 goodies like Canvas and Web Audio API) and provides a familiar GUI-building toolkit (DOM, CSS and such).

Additional great thing about making your game with node-webkit is that you are building a real desktop app. E.g. it allows you to publish your game on steam, gog.com and Windows 8 Store. For example check out the [Game Dev Tycoon](http://www.greenheartgames.com/app/game-dev-tycoon/) title from Greenheart Games. They are using node-webkit and publish everywhere they can.

[JavaScript](https://developer.mozilla.org/en/docs/Web/JavaScript) itself also looks powerful enough to handle CPU-bound calculations - with v8 JIT compiler your code can perform very well if you know what you are doing.

For me JavaScript have two problems though that set a limit for developer creativity:
 - lack of multithreading support
 - garbage collector

But these problems go far beyond this tutorial's scope. Instead I want to describe the whole process of creating a simple game from scratch. The technology set will be as follows:
 - UDP for networking.
   Glenn Fiedler wrote a [great article](http://gafferongames.com/networking-for-game-programmers/udp-vs-tcp/) explaining why (and how) we should use (only) UDP for games. We'll use Node.js [dgram](http://nodejs.org/api/dgram.html) module to access this technology and roll our own protocol based on Glenn's articles.
 - [WebGL](https://www.khronos.org/registry/webgl/specs/1.0/) for graphics.
   Or you can stick with plain 2D Canvas if you want. I am using WebGL just because I have more experience with it. If your WebGL/OpenGL skills are rusty or non-existed [start here](https://developer.mozilla.org/en-US/docs/Web/WebGL) and get back to this article when your are ready.
 - Plain old DOM with [jQuery](http://jquery.com) support for GUI.
   This includes "insert coin" menus and in-game interfaces as well. We'll also use [jQuery.hotkeys](https://github.com/jeresig/jquery.hotkeys) library by John Resig to handle keyboard input.
 - [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) for music and sound.
   There are also some Node.js-based options here, but for me this API works quite well. Here is a good [Web Audio API tutorial](http://www.html5rocks.com/en/tutorials/webaudio/intro/) if you haven't tried it before.

The game will be client-server, with "dumb" client: I don't want to spend too much time talking about client-side prediction and such. Single-player mode will be implemented exactly like multiplayer - we just launch the game server locally and connect to it through localhost. From the gameplay point of view we'll stick with top-down perspective 2D tile-based experience and keyboard+mouse controls.

I am implementing the game in parallel with writing this blog posts so you can treat everything as a work-in-progress. I also reserve the right to "change my mind" about anything implemented in previous posts.

<!--more-->

In Soviet Russia Window Opens You
---------------------------------
Imaging a Node.js application development process. You implement your application logic and orchestrate tools provided by the Node.js platform. Like so:

```
// require tools provided by the platform
var fs = require("fs");
var os = require("os");
// use tools
fs.readFile('/tmp/hello', function (err, data) {
    if (err) throw err;
    // application logic
    if (data.indexOf("world") == 0) {
        // use tools again
        console.log(os.cpus());
    }
});
```

We would like to use webkit-based tools in the same way. Like so:

```
// require tools provided by the platform
var webkit = require("webkit");
// use tools
webkit.openWindow(function (window) {
    var $ = window.$;
    $("body").text("Press X to start");
    // application logic
    $(window.document).bind("keydown", "x", function () {
        // use tools again
        $("body").text("Game started. Enjoy!");
    });
});
```

Unfortunately you can't do it this way with node-webkit. Everything is turned upside-down a bit: you start node-webkit specifying an HTML file (e.g. `launcher.html`) that should be opened in a webkit window and parameters of this window (like width, resizability etc). Node-webkit opens a window like you specified and allows you to `require` Node.js modules from JavaScript in `launcher.html` like so:

```
<!DOCTYPE html>
<html>
  <head>
    <script>
        var fs = require("fs");
        fs.readFile('/tmp/hello', function (err, data) {
            document.body.innerText = data;
        });
    </script>
  </head>
  <body>
    Loading...
  </body>
</html>
```

This approach works quite well for existing Node.js applications that just want to add some GUI around the main logic. But for game development that's a bit ugly on my opinion so we need to turn it back to normal. Algorithm will be as follows:
 - Node-webkit opens a window with `launcher.html` like always.
 - `launcher.html` performs necessary initialization (imports jQuery, graphics library, sound etc) and some resources pre-loading (like pre-loading images that will be used in textures).
 - `launcher.html` `require`s something like `webkit.js` - Node.js module to hold handles to all webkit-based tools and initializes it with actual handles. (e.g. `require("./webkit.js").window = window`)
 - After that `launcher.html` `require`s `app.js` - main application module.
 - `app.js` now can `require` this `webkit.js` and have access to all the tools.

There are some drawbacks when using such approach (e.g. the resulting game will be much harder to port to other platforms - like Cordova/PhoneGap where you doesn't have Node.js at all). But if you just want to make a desktop game (or prototype) this approach works quite well and we'll stick with it in this tutorial).

Project Structure
-----------------
Here is a project layout I am using to bring all of this together. I don't like `webkit` name, so I am using just `frame` to reference my webkit-based tools. `app.js` is called `client/index.js` in our case, because we have two separated applications: client and server.

```
├── bin                   # vendorize both Node.js and node-webkit (for OS X it's like ~80Mb)
├── client                # everything client-only
│   ├── frame             # actual node-webkit entry-point
│   │   ├── lib           # jquery with plugins and other browser-bound libraries
│   │   ├── resource      # css, images, shaders etc.
│   │   ├── ...           # browser-bound modules
│   │   ├── launcher.html # this will be opened in webkit window
│   │   └── package.json  # node-webkit config
│   ├── frame.js          # access webkit features by `require`ing this module
│   ├── config.js         # client config (what shaders to pre-load etc)
│   ├── ...               # client-only subsystems: gui, render, menus etc
│   └── index.js          # client entry-point (will be called from `frame` after pre-loading)
├── node_modules          # Node.js libraries
├── config.js             # shared config
├── ...                   # shared subsystems (like network protocol, actual game logic etc)
└── server                # everything server-only
    ├── config.js         # server config
    ├── ...               # server-only subsystems (saving game state to disk etc)
    └── index.js          # server entry-point
```

To launch the server we can use something like `bin/node server`. It's just a plain Node.js application having nothing to do with node-webkit at all. Client part works like described above. We launch it by issuing `bin/nw client/frame`. It first reads config from `client/frame/package.json`, where we can put things like initial window size, fullscreen and such. Also we specify `launcher.html` to be node-webkit "main" module. In `launcher.html` we initialize all webkit-bound subsystems (like sound and DOM), pre-load some resources and call `client/index.js` as a logical entry-point of our client code.

Now our `client/index.js` can be coded a lot cleaner:

``` javascript
var frame = require("./frame.js");
var $ = frame.$;

$("body").text("Press X to start");
$(frame.document).bind("keydown", "x", function () {
    $("body").text("Game started. Enjoy!");
});
```

If you want to have several windows in your application you need to modify this approach a bit. We just don't need this for games so I am skipping it over.

Check out the full source code of this project template [on github](https://github.com/vbo/node-webkit-mp-game-template/tree/aaf9e23a45734d80d991929f8c6306fc80bacae6). It does not include binaries so you need to download them separately.

Implementing Game Development Toolset
-------------------------------------
Now we have all the structure in place and nearly ready to proceed to actual implementation of our game. We only need a bunch of simple foundation libraries defined as wrappers around actual webkit features. We'll be taking one subsystem at time and make a minimal version sufficient for our project while keeping it general enough to use in oher projects as well. We'll use [RequireJS library](http://requirejs.org/) to take care about dependencies between this subsystems.

### Storage
To start from something simple we need a basic key-value storage for things like recently-used server IP address and local game configuration. HTML5 [`localStorage`](https://developer.mozilla.org/en-US/docs/Web/Guide/API/DOM/Storage) should be sufficient for now, but we need to wrap it in a library on our own anyway e.g. so we can easily migrate to something more powerful (like Web SQL Database) in the future.

``` javascript client/frame/storage.js
define([], function () {
    var storage = {};

    storage.setItem = function (key, value) {
        return localStorage.setItem(key, value);
    };

    storage.getItem = function (key) {
        return localStorage.getItem(key);
    };

    return storage;
});
```

That's just a tiny wrapper around `localStorage` API, implemented as a RequireJS module. It doesn't have any dependencies, but other systems now can depend on it. Like with other systems we need to put the storage handle to our `frame.js` module. This module should now look as follows:

``` javascript client/frame.js
exports.nativeGui = null;
exports.nativeWindow = null;
exports.document = null;
exports.$ = null;
exports.storage = null;
// put new subsystems' handle variables here...

exports.init = function (gui, window, $, storage) {
    exports.nativeGui = gui;
    exports.nativeWindow = window;
    exports.document = window.document;
    exports.$ = $;
    exports.storage = storage;
    // initialize new handles here...
};
```

`frame.init` function should be called from `client/frame/launcher.js`. It's a RequireJS main module, where we put everything together. Don't forget to put new subsystems' initialization here!

``` javascript client/frame/launcher.js
requirejs.config({
    // here we can configure shims for browser-bound libraries like jQuery, it's plugins etc
});

requirejs(["jquery", "jquery.hotkeys", "storage"], function ($, _, storage) {
    var config = require("../config");
    var gui = require("nw.gui");
    require("../frame.js").init(gui, window, $, storage);
    $('#preloader').hide();
    require("../");
});
```

### Resource Loader
We need a basic resource loader, able to download text and binary data from our resource folder. We can do this from Node.js (using `fs` module) or just via an [XHR](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest), like so:

``` javascript client/frame/resource.js
define([], function () {
    var loaded = {};
    var resourceManager = {};

    resourceManager.load = function (url, ready, text) {
        text = !!text;
        if (loaded[url]) {
            ready(loaded[url]);
        } else {
            console.log("loading resource " + url + (text ? " as text" : " as binary"));
            var request = new XMLHttpRequest();
            request.open("GET", "./resource/" + url, true);
            request.responseType = text ? "text" : "arraybuffer";
            request.onload = function() {
                loaded[url] = request.response;
                ready(loaded[url]);
            };
            request.onerror = function() {
                throw new Error('Resource loading error: XHR error. URL:' + url);
            };
            request.send();
        }
    };

    return resourceManager;
});
```

That's a pretty basic implementation and we'll be constantly improving it later in this tutorial, but for now that's all we need to implement more sophisticated system: sound!

### Sound
For most games we need a foundation sound library satisfying the following requirements:
 - Simultaneously play music and sound effects.
 - Separated gain (volume) controls for music and effects plus a single master control.
 - Smooth transition between music tracks.
 - Sound tracks pre-loading.

This will be our first module with pre-loading. So we need not only to `require` it from `launcher.js` but also to call something like `sound.init` before the library become usable. This module also need some configuration (like default gain). From the API design standpoint I like to use the concept of music "moods": we define tracks as urls with unique short ids and then define what ids correspond to a particular mood (e.g. "calm", "level1" or "menu"). Here is a section of `client/config.js` related to sound subsystem so you can see an illustration:

``` javascript
exports.sound = {
    defaultGain: {
        master: 0.6,
        music: 0.5,
        effects: 0.4
    },
    music: {
        menu: ["m1", "m2"],
        calm: ["m1", "m2"],
        action: ["m1", "m3"]
    },
    preload: ["m1", "m2", "m3"],
    tracks: {
        m1: 'audio/music/magicchoop1.ogg',
        m2: 'audio/music/POPISHNEWMAGIC.ogg',
        m3: 'audio/music/n3xtik.ogg'
    }
};
```

Sources of the initial version of `client/frame/sound.js` can be found [on github](https://github.com/vbo/node-webkit-mp-game-template/blob/edfd9b734fd3f15e49ee0a95f1078f7308c5d667/client/frame/sound.js) (thats a bit too much code to include in the blog post). Here is a usage example:

```
var sound = require("./frame.js").sound;

sound.setMusicMood("menu");       // smoothly change music to the one of "menu" mood
sound.setMusicMood("menu", true); // force to switch track keeping the same mood
sound.play("burst_laser");        // play sound from "burst_laser" track right now
sound.play("alarm", 1.25);        // schedule to play "alarm" sound in 1.25 seconds
```

### Graphics
Foundation library for graphics will be simpler than the sound one because it provides only basics: it is hard to determine an API suitable for more than one application. Graphics is one of the most performance-critical parts of application and we usually want a fine-grained control over every operation. Looks like there are only two routines that all application perform identically:
 - Context initialization.
 - Shaders compilation and linkage.

We can also pre-load sources of all shaders used by application - it's just tiny pieces of text so we don't need to accurately load them only when needed. I also take the liberty to assume that everybody use shaders in pairs of vertex and fragment shaders sharing the same base name. If some application wants to reuse the same shader in different programs or pre-process them somehow they can do this too because our graphics tool will be exposing all the underlying WebGL functions.

``` javascript client/frame/graphics.js
define(["resource"], function (resource) {
    var graphics = {};
    var shaderSources = {};

    graphics.init = function (config, clb) {
        function loadShaderPair (id) {
            ['f', 'v'].forEach(function (type) {
                resource.load("shader/" + id + "." + type + ".glsl", "text", function (source) {
                    shaderSources[id + "." + type] = source;
                });
            });
        }
        config.shaders.forEach(loadShaderPair);
        var shadersCnt = config.shaders.length * 2;
        var waitId = setInterval(function () {
            if (Object.keys(shaderSources).length === shadersCnt) {
                clearInterval(waitId);
                clb();
            }
        }, 20);
    };

    graphics.createContext = function (canvas, antialias) {
        var attributes = {
            antialias: !!antialias
        };
        var context = canvas.getContext("webgl", attributes);
        if (!context) throw new Error("Unable to initialize WebGL");
        return context;
    };

    graphics.createShaderProg = function (gl, id) {
        var fragment = graphics.loadShader(gl, id, true);
        var vertex = graphics.loadShader(gl, id, false);
        var prog = gl.createProgram();
        gl.attachShader(prog, vertex);
        gl.attachShader(prog, fragment);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error("Linker failed on program " + id);
        }
        return prog;
    };

    graphics.loadShader = function (gl, id, is_fragment) {
        is_fragment = !!is_fragment;
        var shaderType = is_fragment ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER;
        var shaderId = id + (is_fragment ? ".f" : ".v");
        var source = shaderSources[shaderId];
        if (!source) throw new Error("Undefined shader: " + shaderId);
        var shader = gl.createShader(shaderType);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error("An error occurred compiling shader " + shaderId
                + ": " + gl.getShaderInfoLog(shader));
        }
        return shader;
    };

    return graphics;
});
```

Now we have two modules with pre-loading so we want to somehow pre-load them in parallel. For this I suggest to use Node.js [`async`](https://github.com/caolan/async) library. Here is the most important section of `launcher.js` updated to handle new subsystems:

```
requirejs([
    "jquery", "jquery.hotkeys", "storage", "resource", "sound", "graphics"
], function (
    $, _, storage, resource, sound, graphics
) {
    var config = require("../config");
    var gui = require("nw.gui");
    config.debug = !!gui.App.manifest.nw.tools;
    var async = require("async");
    async.parallel([
        function (clb) { sound.init(config.sound, clb); },
        function (clb) { graphics.init(config.graphics, clb); }
    ], function () {
        require("../frame.js").init(gui, window, $, storage, resource, sound, graphics);
        $('#preloader').hide();
        require("../index");
    });
});
```

With this minimalistic graphics foundation library we can start to draw something on screen. For this project I think it's ok to stick with exactly one fullscreen canvas, created on first use. We want to be able to hide and show this canvas using a bit of CSS and also have an ability to put some DOM elements in front of it (like game HUD, dialogue boxes etc). To operate this canvas and draw things on it we'll be using our first project-specific module: `client/render.js`:

``` javascript client/render.js
var frame = require("./frame.js");
var $ = frame.$;
var graphics = frame.graphics;

var devicePixelRatio = frame.nativeWindow['devicePixelRatio'] || 1;

// create markup
var $canvas = $('<canvas class="panel"></canvas>').hide().appendTo("body");
$canvas.css({position: "absolute", top: 0, left: 0, right: 0, bottom: 0});
// init context
var gl = graphics.createContext($canvas[0], false);
// handle resize
frame.nativeWindow.onresize = onResize;
onResize();
// initialize your graphics pipeline:
// create shader programs, buffer and such

exports.redraw = function () {
    // draw actual scene here
};

// utility functions
function clear () {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BUT);
}

function onResize () {
    var w = $('body').width();
    var h = $(frame.nativeWindow).height();
    $canvas.width(w);
    $canvas.height(h);
    var canvasEl = $canvas[0];
    canvasEl.width = w * devicePixelRatio;
    canvasEl.height = h * devicePixelRatio;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    clear();
}

exports.show = function () {
    $('.panel').hide();
    $canvas.show();
};
```

Actual source code for this part of tutorial available [on github](https://github.com/vbo/node-webkit-mp-game-template/tree/minimal_toolset). I have just implemented a "Hello Triangle" graphics but we'll make a real render later on this tutorial. Stay in tune! UPD: part two is [online](/building-multiplayer-game-nodejs-node-webkit-tiles-sprites/).

Here is a screenshot of what we have right now. I can't show this on screenshot, but we also have a nice background music, nice and simple sound effects API, ability to subsribe to keyboard events and use jQuery-powered DOM to easily make any GUI we need.

<img src="triangle.png"/>
