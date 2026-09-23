package logic

import (
	"math/rand"
	"sync"
	"time"

	"github.com/dobyte/due/cluster/node"
	"github.com/dobyte/due/session"
)

type GameStage int

const (
	Preparing     GameStage = 0
	Night         GameStage = 1
	Proposing     GameStage = 2
	Voting        GameStage = 3
	Mission       GameStage = 4
	Assassinating GameStage = 5
	End           GameStage = 6
)

type Player struct {
	UID      int64   `json:"userId"`
	Nickname string  `json:"nickname"`
	Avatar   string  `json:"avatar"`
	IsReady  bool    `json:"isReady"`
	Seat     int     `json:"seatIndex"`
	Role     int     `json:"role"`
	IsAI     bool    `json:"isAi"`
	Agent    AIAgent `json:"-"`
}

type Room struct {
	ID             string
	Players        []*Player
	Stage          GameStage
	CaptainIdx     int
	Round          int // 1-5
	FailedVotes    int // 连黑
	MissionResults []bool

	SelectedSeats  []int
	Votes          map[int64]bool
	MissionActions map[int64]bool

	mu sync.Mutex
}

func NewRoom(id string) *Room {
	return &Room{
		ID:             id,
		Players:        make([]*Player, 0),
		Stage:          Preparing,
		Votes:          make(map[int64]bool),
		MissionActions: make(map[int64]bool),
		MissionResults: make([]bool, 0),
	}
}

func (r *Room) AddPlayer(uid int64, nickname, avatar string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.Players) >= 10 {
		return false
	}
	for _, p := range r.Players {
		if p.UID == uid {
			return true
		}
	}
	r.Players = append(r.Players, &Player{
		UID:      uid,
		Nickname: nickname,
		Avatar:   avatar,
		Seat:     len(r.Players),
	})
	return true
}

func (r *Room) AddAIPlayer(uid int64, nickname string, agent AIAgent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Players = append(r.Players, &Player{
		UID:      uid,
		Nickname: nickname,
		IsReady:  true,
		Seat:     len(r.Players),
		IsAI:     true,
		Agent:    agent,
	})
}

func (r *Room) SetReady(uid int64, ready bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	allReady := true
	for _, p := range r.Players {
		if p.UID == uid {
			p.IsReady = ready
		}
		if !p.IsReady {
			allReady = false
		}
	}
	return allReady && len(r.Players) >= 5
}

const (
	Unknown  int = 0
	Merlin   int = 1
	Percival int = 2
	Servant  int = 3
	Assassin int = 4
	Morgana  int = 5
	Minion   int = 6
	Oberon   int = 7
	Mordred  int = 8
)

func (r *Room) StartGame() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Stage = Night
	r.Round = 1
	r.FailedVotes = 0

	n := len(r.Players)
	roles := make([]int, 0, n)

	// Role Assignment based on player count
	switch n {
	case 5:
		roles = []int{Merlin, Percival, Servant, Assassin, Morgana}
	case 6:
		roles = []int{Merlin, Percival, Servant, Servant, Assassin, Morgana}
	case 7:
		roles = []int{Merlin, Percival, Servant, Servant, Assassin, Morgana, Oberon}
	case 8:
		roles = []int{Merlin, Percival, Servant, Servant, Servant, Assassin, Morgana, Oberon}
	case 9:
		roles = []int{Merlin, Percival, Servant, Servant, Servant, Servant, Assassin, Morgana, Minion}
	case 10:
		roles = []int{Merlin, Percival, Servant, Servant, Servant, Servant, Assassin, Morgana, Mordred, Minion}
	default:
		// Fallback for other counts
		roles = make([]int, n)
		roles[0] = Merlin
		roles[1] = Assassin
		badCount := n/3 + 1
		for i := 2; i < n; i++ {
			if i < badCount {
				roles[i] = Minion
			} else {
				roles[i] = Servant
			}
		}
	}

	rand.Seed(time.Now().UnixNano())
	rand.Shuffle(len(roles), func(i, j int) { roles[i], roles[j] = roles[j], roles[i] })

	for i, p := range r.Players {
		p.Role = roles[i]
	}
	r.CaptainIdx = rand.Intn(len(r.Players))
}

func (r *Room) GetIdentityInfo(player *Player) []int {
	visibleSeats := make([]int, 0)
	switch player.Role {
	case Merlin:
		// Sees all bad players except Mordred
		for _, p := range r.Players {
			if p.Role == Assassin || p.Role == Morgana || p.Role == Minion || p.Role == Oberon {
				visibleSeats = append(visibleSeats, p.Seat)
			}
		}
	case Percival:
		// Sees Merlin and Morgana
		for _, p := range r.Players {
			if p.Role == Merlin || p.Role == Morgana {
				visibleSeats = append(visibleSeats, p.Seat)
			}
		}
	case Assassin, Morgana, Minion, Mordred:
		// See each other except Oberon
		for _, p := range r.Players {
			if p.UID == player.UID {
				continue
			}
			if p.Role == Assassin || p.Role == Morgana || p.Role == Minion || p.Role == Mordred {
				visibleSeats = append(visibleSeats, p.Seat)
			}
		}
	}
	return visibleSeats
}

func (r *Room) Broadcast(ctx *node.Context, route int32, data interface{}) {
	for _, p := range r.Players {
		if p.IsAI {
			continue
		}
		ctx.Proxy.Push(ctx.Context(), &node.PushArgs{
			Kind:   session.User,
			Target: p.UID,
			Message: &node.Message{
				Route: route,
				Data:  data,
			},
		})
	}
}

func (r *Room) PushIdentity(ctx *node.Context) {
	for _, p := range r.Players {
		if p.IsAI {
			continue
		}
		visibleSeats := r.GetIdentityInfo(p)
		ctx.Proxy.Push(ctx.Context(), &node.PushArgs{
			Kind:   session.User,
			Target: p.UID,
			Message: &node.Message{
				Route: 303, // IdentityPush
				Data: map[string]interface{}{
					"role":         p.Role,
					"visibleSeats": visibleSeats,
				},
			},
		})
	}
}

func (r *Room) Propose(selected []int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.SelectedSeats = selected
	r.Stage = Voting
	r.Votes = make(map[int64]bool)
}

func (r *Room) Vote(uid int64, approve bool) (isFinished bool, isPassed bool, votesArr []bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Votes[uid] = approve
	if len(r.Votes) == len(r.Players) {
		isFinished = true
		approveCount := 0
		votesArr = make([]bool, len(r.Players))
		for i, p := range r.Players {
			v := r.Votes[p.UID]
			votesArr[i] = v
			if v {
				approveCount++
			}
		}
		isPassed = approveCount > len(r.Players)/2
		if isPassed {
			r.Stage = Mission
			r.MissionActions = make(map[int64]bool)
			r.FailedVotes = 0
		} else {
			r.FailedVotes++
			if r.FailedVotes >= 5 {
				r.Stage = End
			} else {
				r.CaptainIdx = (r.CaptainIdx + 1) % len(r.Players)
				r.Stage = Proposing
			}
		}
	}
	return
}

func (r *Room) Mission(uid int64, success bool) (isFinished bool, isSuccess bool, failCount int, round int, goodWins int, badWins int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.MissionActions[uid] = success
	if len(r.MissionActions) == len(r.SelectedSeats) {
		isFinished = true
		for _, v := range r.MissionActions {
			if !v {
				failCount++
			}
		}
		isSuccess = failCount == 0
		// 特殊规则：7人局及以上，第4轮任务需要2张失败票才算失败？
		if len(r.Players) >= 7 && r.Round == 4 {
			isSuccess = failCount < 2
		}

		r.MissionResults = append(r.MissionResults, isSuccess)
		round = r.Round

		for _, res := range r.MissionResults {
			if res {
				goodWins++
			} else {
				badWins++
			}
		}

		if badWins >= 3 {
			r.Stage = End
		} else if goodWins >= 3 {
			r.Stage = Assassinating
		} else {
			r.Round++
			r.CaptainIdx = (r.CaptainIdx + 1) % len(r.Players)
			r.Stage = Proposing
		}
	}
	return
}

func (r *Room) Assassinate(targetSeat int) (isGoodWin bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	target := r.Players[targetSeat]
	isGoodWin = target.Role != Merlin
	r.Stage = End
	return
}

func (r *Room) GetStateForAI() (GameStage, int, []*Player, []int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.Stage, r.CaptainIdx, r.Players, r.SelectedSeats
}

func (r *Room) HasVoted(uid int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.Votes[uid]
	return ok
}

func (r *Room) HasActedMission(uid int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.MissionActions[uid]
	return ok
}

func (r *Room) SetStage(stage GameStage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Stage = stage
}

func (r *Room) GetStage() GameStage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.Stage
}

func (r *Room) GetTeamSize() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(r.Players)
	matrix := map[int][]int{
		5:  {2, 3, 2, 3, 3},
		6:  {2, 3, 4, 3, 4},
		7:  {2, 3, 3, 4, 4},
		8:  {3, 4, 4, 5, 5},
		9:  {3, 4, 4, 5, 5},
		10: {3, 4, 4, 5, 5},
	}
	if sizes, ok := matrix[n]; ok {
		return sizes[r.Round-1]
	}
	return 2
}
