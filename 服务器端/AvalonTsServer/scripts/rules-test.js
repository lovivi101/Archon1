const assert = require("node:assert/strict");
const { AvalonRoom } = require("../dist/game.service.js");

const room = new AvalonRoom();
room.players.push({
    userId: "human", nickname: "Tester", avatar: "", isReady: true,
    seatIndex: 4, role: 3, isAi: false,
});
room.stage = 3;
assert.equal(room.vote("human", true).finished, false);
assert.equal(room.vote("human", false).finished, false);
assert.equal(room.votes.get("human"), true, "duplicate vote must not overwrite the first ballot");

room.stage = 4;
room.selectedSeats = [0, 4];
assert.equal(room.mission("human", false).finished, false);
assert.equal(room.missionActions.size, 0, "good player must not submit a failure card");
assert.equal(room.mission("human", true).finished, false);
assert.equal(room.mission("human", false).finished, false);
assert.equal(room.missionActions.get("human"), true, "duplicate mission card must not overwrite the first card");
console.log("PASS vote and mission rule guards");
