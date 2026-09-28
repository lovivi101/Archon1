package logic

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"strings"
)

// AIAgent 接口定义
type AIAgent interface {
	DecidePropose(room *Room, p *Player) []int
	DecideVote(p *Player, proposedSeats []int) bool
	DecideMission(p *Player) bool
	DecideAssassinate(room *Room) int
}

// GenericAgent 通用 OpenAI 兼容模型 Agent (支持智谱、硅基流动、百度等)
type GenericAgent struct {
	APIKey  string
	Model   string
	BaseURL string
}

// OpenAI 兼容请求结构
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
}

type ChatResponse struct {
	Choices []struct {
		Message ChatMessage `json:"message"`
	} `json:"choices"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

// call 通用 API 调用方法
func (a *GenericAgent) call(systemPrompt, userPrompt string) string {
	if a.APIKey == "" || a.BaseURL == "" {
		return ""
	}

	reqBody := ChatRequest{
		Model: a.Model,
		Messages: []ChatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	}

	jsonData, _ := json.Marshal(reqBody)
	url := a.BaseURL
	if !strings.HasSuffix(url, "/chat/completions") {
		url += "/chat/completions"
	}

	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.APIKey)

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("Generic AI Error: %v\n", err)
		return ""
	}
	defer resp.Body.Close()

	body, _ := ioutil.ReadAll(resp.Body)
	var chatResp ChatResponse
	if err := json.Unmarshal(body, &chatResp); err != nil {
		fmt.Printf("Generic AI Parse Error: %v\n", err)
		return ""
	}

	if chatResp.Error.Message != "" {
		fmt.Printf("Generic AI API Error: %s\n", chatResp.Error.Message)
		return ""
	}

	if len(chatResp.Choices) > 0 {
		return chatResp.Choices[0].Message.Content
	}

	return ""
}

// DecidePropose 决定提议名单
func (a *GenericAgent) DecidePropose(room *Room, p *Player) []int {
	systemPrompt := "你是一个阿瓦隆对战的高手。请根据当前对局状态做出组队决策。直接输出座位号数字，用逗号分隔，不要有任何废话。"
	userPrompt := fmt.Sprintf("游戏总人数: %d, 你的座位: %d, 你的角色: %d (1:梅林, 4:刺客, 3:忠臣), 当前第 %d 轮。你需要挑选 %d 个队员。队员座位号范围 0 到 %d。",
		len(room.Players), p.Seat, p.Role, room.Round, room.GetTeamSize(), len(room.Players)-1)

	res := a.call(systemPrompt, userPrompt)
	if res == "" {
		return (&MockAI{}).DecidePropose(room, p)
	}

	// 解析逗号分隔的数字
	parts := strings.FieldsFunc(res, func(r rune) bool {
		return r == ',' || r == ' ' || r == '，'
	})

	selected := []int{}
	for _, part := range parts {
		var seat int
		fmt.Sscanf(part, "%d", &seat)
		if seat >= 0 && seat < len(room.Players) {
			selected = append(selected, seat)
		}
	}

	if len(selected) == 0 {
		return (&MockAI{}).DecidePropose(room, p)
	}
	return selected
}

// DecideVote 决定是否通过投票
func (a *GenericAgent) DecideVote(p *Player, proposedSeats []int) bool {
	systemPrompt := "你是一个阿瓦隆对战的高手。请决定是否赞成当前的组队提议。只回答 true 或 false。"
	userPrompt := fmt.Sprintf("当前提议小队座位号: %v, 你的角色: %d。你觉得这个小队可靠吗？", proposedSeats, p.Role)

	res := strings.ToLower(a.call(systemPrompt, userPrompt))
	if res == "" {
		return true
	}
	return strings.Contains(res, "true") || strings.Contains(res, "yes") || strings.Contains(res, "赞成")
}

// DecideMission 决定任务是否成功 (坏人可能投失败)
func (a *GenericAgent) DecideMission(p *Player) bool {
	if p.Role <= 3 { // 好人阵营 (梅林、派西维尔、忠臣)
		return true
	}
	// 坏人阵营逻辑：简单处理先直接投失败，以后可以增加“深水”策略
	return false
}

// DecideAssassinate 刺客决定刺杀谁
func (a *GenericAgent) DecideAssassinate(room *Room) int {
	systemPrompt := "你是一个阿瓦隆对战的坏人阵营刺客。你需要选出你认为是梅林的座位号。直接输出一个数字。"
	userPrompt := "好人任务已达成3次。请根据全场表现，在所有非坏人玩家中挑出梅林。输出一个座位号。"

	res := a.call(systemPrompt, userPrompt)
	var seat int
	fmt.Sscanf(res, "%d", &seat)
	return seat
}

// MockAI 兜底用
type MockAI struct{}

func (m *MockAI) DecidePropose(room *Room, p *Player) []int {
	count := room.GetTeamSize()
	seats := []int{}
	for i := 0; i < count; i++ {
		seats = append(seats, (p.Seat+i)%len(room.Players))
	}
	return seats
}

func (m *MockAI) DecideVote(p *Player, proposedSeats []int) bool {
	return true
}

func (m *MockAI) DecideMission(p *Player) bool {
	return p.Role <= 3
}

func (m *MockAI) DecideAssassinate(room *Room) int {
	return 0
}
