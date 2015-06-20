layout: page
---
## [Building a Multiplayer Game with Node.js and Node-webkit](/building-multiplayer-game-nodejs-node-webkit/)
A series of articles where I am describing a process of creating a desktop multiplayer game in Node.js using node-webkit, WebGL, Web Audio API and UDP. The source code of the game is available [here](https://github.com/vbo/node-webkit-mp-game-template).

List of articles:
 - [Toolset](/building-multiplayer-game-nodejs-node-webkit/)
   Where we are setting up node-webkit and implementing a "low-level" platform layer (basically just convenient access from Node.js to DOM, sound, WebGL etc).
 - [Tiles and Sprites](/building-multiplayer-game-nodejs-node-webkit-tiles-sprites/)
   Where we are thinking about game coordinate system, tiles and sprites rendering implementation and such.
 - [Networking in General](/building-multiplayer-game-nodejs-node-webkit-networking-general/)
   Where I am talking about ways to make our game multiplayer, implementing a game server and client/server messaging protocol.
 - Next part will be about actual game-specific networking and I am still in the process of writing it =)

## [Handmade Hero Platform Layer Implementation for OS X](https://github.com/vbo/handmadehero_osx_platform_layer)
[Handmade Hero](https://handmadehero.org/) is a very interesting project by Casey Muratori where he is creating a complete, professional-quality game entirely from scratch: no libraries, no engine etc. Project is accompanied by videos that explain every single line of source code.

I am very excited and enthusiastic about this project and following along in my spare time on OS X platform. I've even made a pretty decent OS X platform layer by myself and very proud of it =). Check out the source code [here](https://github.com/vbo/handmadehero_osx_platform_layer) and if you are interested in things like Cocoa, Core Audio, IOKit and such it would be nice to have a code review =).

## About Me
Name's Vadim Borodin. I am professional programmer and a kind of software enthusiast currently based in Moscow, Russia. I am mostly doing web programming and system integration stuff on a daily basis but on my spare time I am exploring other areas (like game development), learning different programming languages and experimenting with modern (and old-school) technologies.

Contact me via <a href="mailto:vbo@vbo.name">email</a>, follow me on <a href="https://github.com/vbo">github</a> or check out my writings on this site.
