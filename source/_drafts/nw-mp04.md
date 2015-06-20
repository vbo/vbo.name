title: "Building a Multiplayer Game with Node.js and Node-webkit: Networking and Game State"
date: 2014-12-20 03:57:36
tags:
permalink: building-multiplayer-game-nodejs-node-webkit-networking-general
---

Designing Game Messages
-----------------------
Definition of actual messages used in the particular game depends havily on the game itself, it's genre and mechanics. But basically in client-server games there are three categories of messages:
 - Taking input from client. Depending on the game genre you may want to pass e.g. state of buttons (e.g. jump pressed + forward pressed) for the current frame or to transmit something more high-level like "move unit N to position B" or "initiate trading with player M". For this tutorial we'll be using the latter option.
 - Passing game simulation results from server to players. This includes e.g. positions of other players, hit points and such. For some games (like low player count shooters) it's better to always pass the whole state of game world (maybe using a kind of delta-compression to fit into client's bandwidth), but if your state is huge and rarely changes drastically (like in Minecraft) you probably want to pass each state-changing event separately. For this tutorial we'll try a kind of hybrid approach.
 - Handling meta information. This includes level loading, lobby, chat, time synch (see below), MOTD and such.

This is a technical tutorial - not some real commercial project - so I don't need to invent unique and awesome game mechanics. I don't have to even make it a *game* actually. Instead I'll try to make something simple but usable as a playground to hack around and try your own game ideas. For example let's implement the concept as follows:

*Each player has one "avatar" that can be controlled directly. Player can move his avatar around e.g. by right-clicking on the map tile he wants to go. In response avatar should choose his path to this tile and (if valid path actually exists) start to slowly move from tile to tile until his target reached. Player can change his mind at any time by clicking somewhere else. Also avatar can destroy walls on the map. Player requests this action by left-clicking to some wall tile near the avatar. If there is a reachable wall avatar starts to "dig" into it and after some time wall gets destroyed.*

That's all for now. Not very exciting but we can expand this mechanics later if we like the basics.

### Taking Input

In classic client-server architecture client only send messages to the server without doing anything locally. Server processes his commands and responds with the updated state of the world. Actually we can implement this with one message type, but let's make two different types just to make it more flexible: `MoveCommandMessage` and `DigCommandMessage`. For both messages we need to specify target tile coordinates e.g. as two integers `(X, Y)`. The implementation of such message types is trivial but check the source code - just in case.

As you can see messages also include a timestamp when the command has been issued. We need this at least to support "changing player's mind" in movement: if server receives a command with lower timestamp than the current command's one server should be able to ignore it. Otherwise server schedules this new command to be performed instead.

Fortunately for that simple logic it doesn't matter how this timestamp corresponds to the server time - actually we can use any monotonic sequence instead. But in the real world client and server should specify timestamps in the same "coordinate system". We'll talk more about client-server time synchronization later in this tutorial.

### Managing Game State

From the client-server networking point of view we want to define our game state as a minimal data structure that is sufficient to show (and voice) the current game situation for the player. It should be minimal to fit into player's network bandwidth and sufficient because we want our client-side code to know nothing or close to nothing about actual game logic.

The first feature of our game (an ability of players to move around) requires our game state to include a list of all connected players, their positions and current movement (e.g. whether they are moving or not and in what direction).

The "digging" feature requires us to have a shared data structure to hold the level map and to somehow manage changes done by players. Digging should also take some time to complete and we need to have enough information to render a pretty digging animation or play a sound effect in a timely manner.

While in a single player game this state thing can be implemented with just a kind of variable changing over time via game loop in multiplayer we have at least two variables (one on the client and one on the server) that could only be synchronized by sending messages via network. With network involved we can't actually ever have this two variables to be synchronized perfectly. The server is always slightly ahead because it calculates new value of the variable and only after that have an ability to notify clients about the changes made. Clients are always behind because it takes some time for messages to make it through the network. In real world things are even worse: lost and out-of-order packets, latency peaks, overcrowded ISPs...

Since this issues can't be solved directly we need to change our goal instead. We need to try to create a good experience for our players even if we need to lie to them a bit about actual game situation: if we are unable to show the truth let's just show something that close enough and also fun, interesting and rewarding so they are too busy to notice any inconsistency.

The current state-of-the-art AAA approach to this (a so-called client side prediction and related techniques) takes too much time to implement properly so we have to take another route. We just say that client experiences everything like it was in the past, let's say 300ms in the past. This delay should be constant (so player has to get used to it only once), sufficient to handle common latency peaks, resends etc and short enough to keep game responsive.

Here is a diagram representing our client-side logic:

<img src="timeline.png"/>

Basically when we receive new State value from the server somehow we just put it into a kind of queue or sorted array. I call it *Timeline*. When we want to draw the current frame we get *Current Time* on the client (like `process.hrtime()` or something) and subtract some constant amount from it (like 300ms, we call it *Rendering Delay*) getting so called *Rendering Time*. Then we find two State values in our queue so our Rendering Time is in between them and somehow calculate an intermediate state we need to draw (or voice or whatever). This is what commonly called *Interpolated State*.

Such approach obviously can't be used in fast-paced games (like shooters) where half of a second is a game changing resource but in my opinion it's quite usable by more tactical games like RPG and such. It's very simple to implement (as you'll see later in this tutorial) and playable at least with point-and-click controls when player doesn't expect immediate reaction from his character.

Overall experience can be easily improved after initial game prototype is ready: e.g. you can add a kind of client-side command pre-validation to provide immediate response to some actions (like "Aye, sir!" sound effect in RTS-like). Actually modern fast-paced shooters use a very similar approach but with shorter Rendering Delay (I think 50ms maximum) and only for non-controllable entities but it's off-topic.

So how we can use our messaging system to get all of this State values from the server? As I said we can obviously just send the whole State we have trying to keep some constant interval. Let's check if we can fit this. Let's say we have 8 players maximum. For each player we need position (8 bytes), current action (digging, moving or idle. 1 byte), action parameters (like 8 bytes). That's `8 * (8 + 1 + 8) = 136` bytes. The protocol itself adds slight overhead and we need a bit more information (e.g. timestamps for start and end of the current action). I think we can fit it to 48 bytes per player maximum and have a room for 20 players in one packet. Or just 4 players and 16 mobs =)

Unfortunately we can't do the same thing with our map thing. Let's say we have 64x64 levels. To have several types of walls and floor we need at least one byte per level map tile. That's `64 * 64 * 1 = 4096` bytes. We can't even fit this into one packet. Fortunately our map changes seldom and in small portions so we can just invent some special way of handling it.

### Initial Map Loading



