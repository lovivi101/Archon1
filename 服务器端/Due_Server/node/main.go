package main

import (
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"avalon-server/node/logic"
	"github.com/dobyte/due"
	"github.com/dobyte/due/cluster/node"
	duejson "github.com/dobyte/due/encoding/json"
	"github.com/dobyte/due/locate/redis"
	"github.com/dobyte/due/registry/etcd"
	"github.com/dobyte/due/transport/grpc"
)

var (
	roomMgr *RoomManager
)

type RoomManager struct {
	rooms map[string]*logic.Room
	mu    sync.RWMutex
}

func (mgr *RoomManager) GetRoom(id string) *logic.Room {
	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	return mgr.rooms[id]
}

func main() {
	roomMgr = &RoomManager{rooms: make(map[string]*logic.Room)}

	// 外部 AI 配置从环境变量读取；未配置时 GenericAgent 会退回 MockAI。
	aiAgent := &logic.GenericAgent{
		APIKey:  os.Getenv("AVALON_AI_API_KEY"),
		Model:   envOrDefault("AVALON_AI_MODEL", "glm-4-flash"),
		BaseURL: os.Getenv("AVALON_AI_BASE_URL"),
	}

	room := logic.NewRoom("888")
	for i := 1; i <= 4; i++ {
		room.AddAIPlayer(int64(2000+i), fmt.Sprintf("AI_Player_%d", i), aiAgent)
	}
	roomMgr.rooms["888"] = room
	fmt.Println("Server initialized with room 888 and 4 AI players")

	container := due.NewContainer()

	locator := redis.NewLocator()
	registry := etcd.NewRegistry()
	transporter := grpc.NewTransporter()

	n := node.NewNode(
		node.WithLocator(locator),
		node.WithRegistry(registry),
		node.WithTransporter(transporter),
		node.WithCodec(duejson.DefaultCodec),
	)

	n.Proxy().Router().AddRouteHandler(101, false, loginHandler)
	n.Proxy().Router().AddRouteHandler(102, false, joinRoomHandler)
	n.Proxy().Router().AddRouteHandler(103, false, readyHandler)
	n.Proxy().Router().AddRouteHandler(401, false, proposeTeamHandler)
	n.Proxy().Router().AddRouteHandler(501, false, voteHandler)
	n.Proxy().Router().AddRouteHandler(601, false, missionHandler)
	n.Proxy().Router().AddRouteHandler(701, false, assassinateHandler)

	container.Add(n)

	go func() {
		for {
			time.Sleep(2 * time.Second)
			processAILogic(n.Proxy())
		}
	}()

	container.Serve()
}

func envOrDefault(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func processAILogic(proxy *node.Proxy) {
	room := roomMgr.GetRoom("888")
	if room == nil {
		return
	}
	stage, captainIdx, players, selectedSeats := room.GetStateForAI()
	if stage == logic.Preparing || stage == logic.End || stage == logic.Night {
		return
	}

	switch stage {
	case logic.Proposing:
		captain := players[captainIdx]
		if captain.IsAI {
			fmt.Printf("AI Captain Seat %d is proposing...\n", captain.Seat)
			selected := captain.Agent.DecidePropose(room, captain)
			handlePropose(proxy, room, selected)
		}
	case logic.Voting:
		for _, p := range players {
			if p.IsAI {
				if !room.HasVoted(p.UID) {
					approve := p.Agent.DecideVote(p, selectedSeats)
					handleVote(proxy, room, p.UID, approve)
				}
			}
		}
	case logic.Mission:
		for _, seat := range selectedSeats {
			p := players[seat]
			if p.IsAI {
				if !room.HasActedMission(p.UID) {
					success := p.Agent.DecideMission(p)
					handleMission(proxy, room, p.UID, success)
				}
			}
		}
	}
}

func handlePropose(proxy *node.Proxy, room *logic.Room, selected []int) {
	room.Propose(selected)
	_, captainIdx, _, selectedSeats := room.GetStateForAI()
	room.Broadcast(&node.Context{Proxy: proxy}, 402, map[string]interface{}{"captainSeat": captainIdx, "selectedSeats": selectedSeats})
	room.Broadcast(&node.Context{Proxy: proxy}, 302, map[string]interface{}{"stage": int(logic.Voting), "timeout": 30})
}

func handleVote(proxy *node.Proxy, room *logic.Room, uid int64, approve bool) {
	isFinished, isPassed, votesArr := room.Vote(uid, approve)
	if isFinished {
		room.Broadcast(&node.Context{Proxy: proxy}, 502, map[string]interface{}{"votes": votesArr, "isPassed": isPassed})
		stage := room.GetStage()
		if stage == logic.Mission {
			room.Broadcast(&node.Context{Proxy: proxy}, 302, map[string]interface{}{"stage": int(logic.Mission), "timeout": 30})
		} else if stage == logic.End {
			room.Broadcast(&node.Context{Proxy: proxy}, 702, map[string]interface{}{"isGoodWin": false, "winReason": "Vote failed 5 times"})
		} else {
			room.Broadcast(&node.Context{Proxy: proxy}, 302, map[string]interface{}{"stage": int(logic.Proposing), "timeout": 60})
		}
	}
}

func handleMission(proxy *node.Proxy, room *logic.Room, uid int64, success bool) {
	isFinished, isSuccess, failCount, round, goodWins, badWins := room.Mission(uid, success)
	if isFinished {
		room.Broadcast(&node.Context{Proxy: proxy}, 602, map[string]interface{}{"isSuccess": isSuccess, "failCount": failCount, "round": round})
		stage := room.GetStage()
		if stage == logic.End {
			room.Broadcast(&node.Context{Proxy: proxy}, 702, map[string]interface{}{"isGoodWin": false, "winReason": "3 Missions failed"})
		} else if stage == logic.Assassinating {
			room.Broadcast(&node.Context{Proxy: proxy}, 302, map[string]interface{}{"stage": int(logic.Assassinating), "timeout": 60})
		} else {
			room.Broadcast(&node.Context{Proxy: proxy}, 302, map[string]interface{}{"stage": int(logic.Proposing), "timeout": 60})
		}
		fmt.Printf("Mission Result: Success=%v, Fails=%d, Round=%d, Good=%d, Bad=%d\n", isSuccess, failCount, round, goodWins, badWins)
	}
}

func loginHandler(ctx *node.Context) {
	var req struct {
		UserID   string `json:"userId"`
		Nickname string `json:"nickname"`
	}
	ctx.Request.Parse(&req)
	if req.UserID == "" {
		req.UserID = fmt.Sprint(ctx.Request.UID)
	}
	uid := parseClientUID(req.UserID, ctx.Request.UID)
	if err := ctx.BindGate(uid); err != nil {
		fmt.Printf("BindGate failed: %v\n", err)
	}
	ctx.Response(map[string]interface{}{"code": 0, "userId": fmt.Sprint(uid)})
}
func joinRoomHandler(ctx *node.Context) {
	room := roomMgr.GetRoom("888")
	var req struct {
		UserID   string `json:"userId"`
		Nickname string `json:"nickname"`
	}
	ctx.Request.Parse(&req)
	uid := parseClientUID(req.UserID, ctx.Request.UID)
	nickname := req.Nickname
	if nickname == "" {
		nickname = "Player_" + fmt.Sprint(uid)
	}
	if err := ctx.BindGate(uid); err != nil {
		fmt.Printf("BindGate failed: %v\n", err)
	}
	room.AddPlayer(uid, nickname, "")
	ctx.Response(map[string]interface{}{"code": 0, "room": room})
}

func parseClientUID(userID string, fallback int64) int64 {
	if userID != "" {
		if uid, err := strconv.ParseInt(userID, 10, 64); err == nil {
			return uid
		}
	}
	if fallback != 0 {
		return fallback
	}
	return time.Now().UnixNano() % 1000000
}
func readyHandler(ctx *node.Context) {
	room := roomMgr.GetRoom("888")
	var req struct {
		UserID string `json:"userId"`
	}
	ctx.Request.Parse(&req)
	uid := parseClientUID(req.UserID, ctx.Request.UID)
	if room.SetReady(uid, true) {
		room.StartGame()
		room.Broadcast(ctx, 301, map[string]interface{}{"msg": "Game Started"})
		room.PushIdentity(ctx)
		room.Broadcast(ctx, 302, map[string]interface{}{"stage": int(logic.Night), "timeout": 10})

		// 10秒后进入提议阶段
		go func(c *node.Context) {
			time.Sleep(10 * time.Second)
			if room.GetStage() == logic.Night {
				room.SetStage(logic.Proposing)
				room.Broadcast(c, 302, map[string]interface{}{"stage": int(logic.Proposing), "timeout": 60})
			}
		}(ctx)
	}
}
func proposeTeamHandler(ctx *node.Context) {
	room := roomMgr.GetRoom("888")
	var req struct {
		SelectedSeats []int `json:"selectedSeats"`
	}
	ctx.Request.Parse(&req)
	handlePropose(ctx.Proxy, room, req.SelectedSeats)
}
func voteHandler(ctx *node.Context) {
	room := roomMgr.GetRoom("888")
	var req struct {
		UserID  string `json:"userId"`
		Approve bool   `json:"approve"`
	}
	ctx.Request.Parse(&req)
	handleVote(ctx.Proxy, room, parseClientUID(req.UserID, ctx.Request.UID), req.Approve)
}
func missionHandler(ctx *node.Context) {
	room := roomMgr.GetRoom("888")
	var req struct {
		UserID  string `json:"userId"`
		Success bool   `json:"success"`
	}
	ctx.Request.Parse(&req)
	handleMission(ctx.Proxy, room, parseClientUID(req.UserID, ctx.Request.UID), req.Success)
}
func assassinateHandler(ctx *node.Context) {
	room := roomMgr.GetRoom("888")
	var req struct {
		TargetSeat int `json:"targetSeat"`
	}
	ctx.Request.Parse(&req)
	isGoodWin := room.Assassinate(req.TargetSeat)
	_, _, players, _ := room.GetStateForAI()
	room.Broadcast(ctx, 702, map[string]interface{}{"isGoodWin": isGoodWin, "winReason": fmt.Sprintf("Assassin targeted Seat %d", req.TargetSeat), "allRoles": players})
}
