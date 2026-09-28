import { _decorator, Button, Color, EditBox, Graphics, Label, Node, UITransform } from "cc";
import mk from "mk";
import { AvalonGameState } from "../Game/AvalonGameState";
import { GameStage, isBadRole, PlayerInfo, Role, roleName, Route, routeName, stageName } from "../Game/AvalonGameTypes";
import { AvalonNetwork, ConnectionState, DisposeHandler } from "../Network/AvalonNetwork";
import { DEFAULT_ROOM_ID, DEFAULT_SERVER_URL } from "../Network/AvalonProtocol";

const { ccclass } = _decorator;

interface SeatView {
    node: Node;
    label: Label;
    mark: Label;
}

interface MissionView {
    node: Node;
    label: Label;
}

@ccclass("AvalonDemoApp")
export class AvalonDemoApp extends mk.StaticViewBase {
    private readonly viewWidth = 720;
    private readonly viewHeight = 1280;
    private readonly maxSeats = 10;

    private uiRoot: Node | null = null;
    private serverUrlInput: EditBox | null = null;
    private nicknameInput: EditBox | null = null;
    private roomInput: EditBox | null = null;
    private connectionLabel: Label | null = null;
    private roomLabel: Label | null = null;
    private stageLabel: Label | null = null;
    private roleLabel: Label | null = null;
    private teamLabel: Label | null = null;
    private visibleLabel: Label | null = null;
    private logLabel: Label | null = null;
    private resultLabel: Label | null = null;
    private seatViews: SeatView[] = [];
    private missionViews: MissionView[] = [];
    private actionButtons: { [key: string]: Node } = {};
    private selectedSeats: number[] = [];
    private logLines: string[] = [];
    private disposers: DisposeHandler[] = [];
    private isBuilt = false;

    protected open(): void {
        if (this.isBuilt) {
            return;
        }

        this.isBuilt = true;
        this.buildView();
        this.bindNetwork();
        this.addLog("Demo 客户端入口已启动");
        this.refresh();
    }

    protected lateClose(): void {
        this.disposers.forEach((dispose) => dispose());
        this.disposers.length = 0;
    }

    private buildView(): void {
        let transform = this.node.getComponent(UITransform);
        if (!transform) {
            transform = this.node.addComponent(UITransform);
        }
        transform.setContentSize(this.viewWidth, this.viewHeight);

        this.node.getChildByName("AvalonDemoRuntime")?.destroy();
        const root = this.createNode(this.node, "AvalonDemoRuntime", 0, 0, this.viewWidth, this.viewHeight);
        this.uiRoot = root;
        this.drawRect(root, this.viewWidth, this.viewHeight, new Color(18, 20, 24, 255));

        this.createLabel(root, "Title", "阿瓦隆联机 Demo", 0, 595, 640, 52, 34, new Color(244, 231, 188, 255));
        this.connectionLabel = this.createLabel(root, "Connection", "", 0, 555, 640, 32, 19, new Color(145, 208, 205, 255));

        this.drawRect(this.createNode(root, "ConnectPanel", 0, 463, 660, 145), 660, 145, new Color(37, 42, 49, 255), new Color(87, 95, 105, 255));
        this.serverUrlInput = this.createEditBox(root, "ServerUrlInput", -95, 500, 410, 44, DEFAULT_SERVER_URL, "服务器地址");
        this.roomInput = this.createEditBox(root, "RoomInput", 205, 500, 120, 44, DEFAULT_ROOM_ID, "房间");
        this.nicknameInput = this.createEditBox(root, "NicknameInput", -205, 445, 190, 44, "Guest", "昵称");
        this.createButton(root, "ConnectButton", "连接", -35, 445, 120, 44, new Color(54, 105, 126, 255), () => this.connect());
        this.createButton(root, "LoginButton", "登录", 100, 445, 110, 44, new Color(89, 80, 133, 255), () => this.login());
        this.createButton(root, "JoinButton", "加入", 225, 445, 105, 44, new Color(93, 111, 78, 255), () => this.joinRoom());
        this.createButton(root, "ReadyButton", "准备", -205, 392, 105, 44, new Color(146, 79, 72, 255), () => this.ready());
        this.createButton(root, "LocalDemoButton", "本地演示", -75, 392, 135, 44, new Color(111, 92, 51, 255), () => this.loadLocalDemo());
        this.createButton(root, "RefreshButton", "刷新", 60, 392, 105, 44, new Color(69, 88, 105, 255), () => this.refresh());
        this.createButton(root, "DisconnectButton", "断开", 185, 392, 105, 44, new Color(94, 70, 73, 255), () => this.disconnect());

        this.drawRect(this.createNode(root, "StatePanel", 0, 310, 660, 125), 660, 125, new Color(30, 34, 40, 255), new Color(86, 75, 48, 255));
        this.roomLabel = this.createLabel(root, "RoomState", "", -170, 340, 300, 34, 20, new Color(220, 224, 214, 255));
        this.stageLabel = this.createLabel(root, "StageState", "", 170, 340, 300, 34, 20, new Color(245, 203, 139, 255));
        this.roleLabel = this.createLabel(root, "RoleState", "", -170, 300, 300, 34, 20, new Color(222, 196, 225, 255));
        this.teamLabel = this.createLabel(root, "TeamState", "", 170, 300, 300, 34, 18, new Color(185, 212, 226, 255));
        this.visibleLabel = this.createLabel(root, "VisibleState", "", 0, 260, 620, 32, 18, new Color(178, 190, 201, 255));

        this.buildMissionTrack(root);
        this.buildSeatGrid(root);
        this.buildActionPanel(root);

        this.resultLabel = this.createLabel(root, "Result", "", 0, -282, 650, 38, 20, new Color(244, 231, 188, 255));
        this.drawRect(this.createNode(root, "LogPanel", 0, -455, 660, 285), 660, 285, new Color(25, 28, 33, 255), new Color(62, 70, 78, 255));
        this.logLabel = this.createLabel(root, "LogText", "", 0, -455, 620, 245, 18, new Color(205, 211, 217, 255));
        this.logLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        this.logLabel.verticalAlign = Label.VerticalAlign.TOP;
        this.logLabel.overflow = Label.Overflow.CLAMP;
    }

    private buildMissionTrack(root: Node): void {
        const startX = -200;
        for (let i = 0; i < 5; i++) {
            const node = this.createNode(root, `Mission_${i}`, startX + i * 100, 215, 82, 34);
            this.drawRect(node, 82, 34, new Color(52, 56, 63, 255), new Color(88, 91, 98, 255));
            const label = this.createLabel(node, `Mission_${i}_Label`, `第${i + 1}局`, 0, 0, 78, 28, 16, new Color(214, 216, 209, 255));
            this.missionViews.push({ node, label });
        }
    }

    private buildSeatGrid(root: Node): void {
        const startX = -272;
        const startY = 128;
        const gapX = 136;
        const gapY = 106;

        for (let i = 0; i < this.maxSeats; i++) {
            const col = i % 5;
            const row = Math.floor(i / 5);
            const node = this.createNode(root, `Seat_${i}`, startX + col * gapX, startY - row * gapY, 118, 88);
            this.drawRect(node, 118, 88, new Color(38, 43, 52, 255), new Color(70, 78, 90, 255));
            node.addComponent(Button);
            node.on(Button.EventType.CLICK, () => this.onSeatClick(i), this);

            const label = this.createLabel(node, `Seat_${i}_Label`, "", 0, 4, 108, 62, 17, new Color(238, 239, 230, 255));
            const mark = this.createLabel(node, `Seat_${i}_Mark`, "", 0, -33, 108, 18, 14, new Color(247, 214, 142, 255));
            this.seatViews.push({ node, label, mark });
        }
    }

    private buildActionPanel(root: Node): void {
        this.drawRect(this.createNode(root, "ActionPanel", 0, -145, 660, 145), 660, 145, new Color(33, 37, 43, 255), new Color(76, 86, 98, 255));
        this.actionButtons.propose = this.createButton(root, "ProposeButton", "提交队伍", -245, -112, 135, 46, new Color(63, 105, 137, 255), () => this.proposeTeam());
        this.actionButtons.voteApprove = this.createButton(root, "VoteApproveButton", "赞成", -92, -112, 112, 46, new Color(72, 128, 86, 255), () => this.vote(true));
        this.actionButtons.voteReject = this.createButton(root, "VoteRejectButton", "反对", 42, -112, 112, 46, new Color(151, 79, 75, 255), () => this.vote(false));
        this.actionButtons.missionSuccess = this.createButton(root, "MissionSuccessButton", "任务成功", 195, -112, 135, 46, new Color(72, 128, 86, 255), () => this.mission(true));
        this.actionButtons.missionFail = this.createButton(root, "MissionFailButton", "任务失败", -84, -174, 135, 46, new Color(151, 79, 75, 255), () => this.mission(false));
        this.actionButtons.assassinate = this.createButton(root, "AssassinateButton", "刺杀选中", 84, -174, 135, 46, new Color(133, 74, 113, 255), () => this.assassinate());
        this.actionButtons.clearSelection = this.createButton(root, "ClearSelectionButton", "清空选择", 252, -174, 135, 46, new Color(83, 90, 100, 255), () => this.clearSelection());
    }

    private bindNetwork(): void {
        const network = AvalonNetwork.instance;

        this.disposers.push(network.onStatus((state: ConnectionState, message: string) => {
            this.addLog(message);
            this.refresh();
        }));

        this.disposers.push(network.registerHandler(Route.Login, (data: any) => {
            if (this.logServerError(data, "登录")) return;
            AvalonGameState.instance.updateLogin(data);
            this.addLog(`登录成功：${AvalonGameState.instance.myId || "unknown"}`);
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.JoinRoom, (data: any) => {
            if (this.logServerError(data, "加入房间")) return;
            AvalonGameState.instance.updateRoomInfo(data);
            this.addLog("已加入房间");
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.RoomInfoInit, (data: any) => {
            AvalonGameState.instance.updateRoomInfo(data);
            this.addLog("收到房间初始化");
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.PlayerJoin, (data: any) => {
            AvalonGameState.instance.updateRoomInfo(data);
            this.addLog("房间成员更新");
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.PlayerReady, (data: any) => {
            AvalonGameState.instance.updateRoomInfo(data);
            this.addLog("准备状态更新");
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.GameStart, () => {
            this.addLog("游戏开始");
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.StageChange, (data: any) => {
            AvalonGameState.instance.applyStageChange(data);
            this.addLog(`阶段切换：${stageName(AvalonGameState.instance.stage)}`);
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.IdentityPush, (data: any) => {
            AvalonGameState.instance.applyIdentity(data);
            this.addLog(`收到身份：${roleName(AvalonGameState.instance.myRole)}`);
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.TeamProposed, (data: any) => {
            AvalonGameState.instance.applyTeamProposed(data);
            this.selectedSeats = [];
            this.addLog(`队伍提议：${AvalonGameState.instance.selectedSeats.join(", ") || "空"}`);
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.VoteResult, (data: any) => {
            const result = AvalonGameState.instance.applyVoteResult(data);
            this.addLog(`投票${result.isPassed ? "通过" : "未通过"}：${result.votes.map((vote) => (vote ? "赞成" : "反对")).join(" / ")}`);
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.MissionResult, (data: any) => {
            const result = AvalonGameState.instance.applyMissionResult(data);
            this.addLog(`第${result.round}局任务${result.isSuccess ? "成功" : "失败"}，失败票 ${result.failCount}`);
            this.refresh();
        }));
        this.disposers.push(network.registerHandler(Route.GameEnd, (data: any) => {
            const result = AvalonGameState.instance.applyGameEnd(data);
            this.addLog(`游戏结束：${result.winReason || (result.isGoodWin ? "好人胜利" : "坏人胜利")}`);
            this.refresh();
        }));
    }

    private logServerError(data: any, action: string): boolean {
        if (data?.code === undefined || Number(data.code) === 0) return false;
        this.addLog(`${action}失败（${data.code}）：${data.message || "服务器拒绝请求"}`);
        this.refresh();
        return true;
    }

    private connect(): void {
        const state = AvalonGameState.instance;
        state.serverUrl = this.serverUrlInput?.string.trim() || DEFAULT_SERVER_URL;
        state.isLocalDemo = false;
        AvalonNetwork.instance.connect(state.serverUrl);
    }

    private disconnect(): void {
        AvalonNetwork.instance.close();
    }

    private login(): void {
        const state = AvalonGameState.instance;
        state.nickname = this.nicknameInput?.string.trim() || "Guest";
        state.ensureUserId();
        state.isLocalDemo = false;

        if (AvalonNetwork.instance.send(Route.Login, { userId: state.myId, nickname: state.nickname })) {
            this.addLog(`发送${routeName(Route.Login)}：${state.nickname}`);
        }
    }

    private joinRoom(): void {
        const state = AvalonGameState.instance;
        state.roomId = this.roomInput?.string.trim() || DEFAULT_ROOM_ID;
        state.nickname = this.nicknameInput?.string.trim() || state.nickname || "Guest";
        state.ensureUserId();
        state.isLocalDemo = false;

        if (AvalonNetwork.instance.send(Route.JoinRoom, { roomId: state.roomId, userId: state.myId, nickname: state.nickname })) {
            this.addLog(`请求加入房间 ${state.roomId}`);
        }
    }

    private ready(): void {
        const state = AvalonGameState.instance;
        state.ensureUserId();

        if (AvalonNetwork.instance.send(Route.Ready, { userId: state.myId })) {
            this.addLog("发送准备");
        }
    }

    private proposeTeam(): void {
        const state = AvalonGameState.instance;
        const expectedSize = state.getExpectedTeamSize();
        if (this.selectedSeats.length !== expectedSize) {
            this.addLog(`当前轮次需要选择 ${expectedSize} 名队员`);
            return;
        }

        if (state.isLocalDemo) {
            this.localProposeTeam();
            return;
        }

        if (AvalonNetwork.instance.send(Route.ProposeTeam, { userId: state.myId, selectedSeats: this.selectedSeats })) {
            this.addLog(`提交队伍：${this.selectedSeats.join(", ")}`);
            this.selectedSeats = [];
            this.refresh();
        }
    }

    private vote(approve: boolean): void {
        const state = AvalonGameState.instance;
        if (state.isLocalDemo) {
            this.localVote(approve);
            return;
        }

        if (AvalonNetwork.instance.send(Route.VoteTeam, { userId: state.myId, approve })) {
            this.addLog(approve ? "投票赞成" : "投票反对");
        }
    }

    private mission(success: boolean): void {
        const state = AvalonGameState.instance;
        if (state.isLocalDemo) {
            this.localMission(success);
            return;
        }

        if (AvalonNetwork.instance.send(Route.MissionAction, { userId: state.myId, success })) {
            this.addLog(success ? "提交任务成功" : "提交任务失败");
        }
    }

    private assassinate(): void {
        const targetSeat = this.selectedSeats[0];
        if (targetSeat === undefined) {
            this.addLog("请先选择刺杀目标");
            return;
        }

        if (AvalonGameState.instance.isLocalDemo) {
            this.localAssassinate(targetSeat);
            return;
        }

        if (AvalonNetwork.instance.send(Route.Assassinate, { userId: AvalonGameState.instance.myId, targetSeat })) {
            this.addLog(`刺杀座位 ${targetSeat}`);
            this.selectedSeats = [];
            this.refresh();
        }
    }

    private loadLocalDemo(): void {
        const state = AvalonGameState.instance;
        state.nickname = this.nicknameInput?.string.trim() || state.nickname || "Guest";
        state.roomId = this.roomInput?.string.trim() || DEFAULT_ROOM_ID;
        state.loadLocalDemo();
        this.selectedSeats = [];
        this.addLog("已加载本地 5 人演示局，可点击座位组队");
        this.refresh();
    }

    private clearSelection(): void {
        this.selectedSeats = [];
        this.refresh();
    }

    private localProposeTeam(): void {
        const state = AvalonGameState.instance;
        state.selectedSeats = this.selectedSeats.slice();
        state.lastVotes = [];
        state.lastVotePassed = false;
        state.stage = GameStage.Voting;
        this.addLog(`本地队伍提交：${state.selectedSeats.join(", ")}`);
        this.selectedSeats = [];
        this.refresh();
    }

    private localVote(approve: boolean): void {
        const state = AvalonGameState.instance;
        const votes = state.players.map((player) => (player.userId === state.myId ? approve : true));
        const approveCount = votes.filter((item) => item).length;
        const isPassed = approveCount > state.players.length / 2;

        state.applyVoteResult({ votes, isPassed });
        if (isPassed) {
            state.stage = GameStage.Mission;
            state.failedVotes = 0;
            this.addLog("本地投票通过，进入任务阶段");
        } else {
            state.failedVotes++;
            state.selectedSeats = [];
            if (state.failedVotes >= 5) {
                state.applyGameEnd({ isGoodWin: false, winReason: "连续 5 次否决，坏人胜利", allRoles: state.players });
                this.addLog("本地投票连续否决 5 次，游戏结束");
            } else {
                state.captainSeat = (state.captainSeat + 1) % Math.max(1, state.players.length);
                state.stage = GameStage.Proposing;
                this.addLog("本地投票未通过，队长轮换");
            }
        }

        this.refresh();
    }

    private localMission(success: boolean): void {
        const state = AvalonGameState.instance;
        const selectedPlayers = state.selectedSeats.map((seat) => state.getPlayerAtSeat(seat)).filter((player): player is PlayerInfo => Boolean(player));
        let failCount = selectedPlayers.filter((player) => player.isAi && isBadRole(player.role)).length;

        if (!success) {
            failCount = Math.max(1, failCount);
        }

        const isSuccess = state.players.length >= 7 && state.currentRound === 4 ? failCount < 2 : failCount === 0;
        const round = state.currentRound;
        state.applyMissionResult({ isSuccess, failCount, round });

        const goodWins = state.missionResults.filter((item) => item === true).length;
        const badWins = state.missionResults.filter((item) => item === false).length;
        this.addLog(`本地第 ${round} 局任务${isSuccess ? "成功" : "失败"}，失败票 ${failCount}`);

        if (badWins >= 3) {
            state.applyGameEnd({ isGoodWin: false, winReason: "任务失败 3 次，坏人胜利", allRoles: state.players });
        } else if (goodWins >= 3) {
            state.stage = GameStage.Assassinating;
            state.selectedSeats = [];
            this.addLog("好人任务成功 3 次，进入刺杀阶段");
        } else {
            state.currentRound = round + 1;
            state.captainSeat = (state.captainSeat + 1) % Math.max(1, state.players.length);
            state.selectedSeats = [];
            state.stage = GameStage.Proposing;
        }

        this.selectedSeats = [];
        this.refresh();
    }

    private localAssassinate(targetSeat: number): void {
        const state = AvalonGameState.instance;
        const target = state.getPlayerAtSeat(targetSeat);
        const isGoodWin = target?.role !== Role.Merlin;
        const targetName = target ? `${target.nickname} / ${roleName(target.role)}` : `座位 ${targetSeat}`;

        state.applyGameEnd({
            isGoodWin,
            winReason: `刺客选择 ${targetName}`,
            allRoles: state.players,
        });
        this.addLog(`本地刺杀：${targetName}`);
        this.selectedSeats = [];
        this.refresh();
    }

    private onSeatClick(seatIndex: number): void {
        const state = AvalonGameState.instance;

        if (state.stage === GameStage.Proposing && state.isCaptain()) {
            const index = this.selectedSeats.indexOf(seatIndex);
            if (index >= 0) {
                this.selectedSeats.splice(index, 1);
            } else if (this.selectedSeats.length < state.getExpectedTeamSize()) {
                this.selectedSeats.push(seatIndex);
            } else {
                this.addLog(`最多选择 ${state.getExpectedTeamSize()} 名队员`);
            }
        } else if (state.stage === GameStage.Assassinating) {
            this.selectedSeats = [seatIndex];
        } else {
            const player = state.getPlayerAtSeat(seatIndex);
            this.addLog(player ? `查看座位 ${seatIndex}：${player.nickname}` : `座位 ${seatIndex} 为空`);
        }

        this.refresh();
    }

    private refresh(): void {
        const state = AvalonGameState.instance;
        const network = AvalonNetwork.instance;
        const mySeat = state.getMySeat();

        if (this.connectionLabel) {
            this.connectionLabel.string = state.isLocalDemo ? "连接：本地演示" : `连接：${this.connectionText(network.state)}  ${network.lastMessage}`;
        }
        if (this.roomLabel) {
            this.roomLabel.string = `房间 ${state.roomId || DEFAULT_ROOM_ID}  玩家 ${state.players.length}/10`;
        }
        if (this.stageLabel) {
            this.stageLabel.string = `阶段：${stageName(state.stage)}  第 ${state.currentRound || 1} 局`;
        }
        if (this.roleLabel) {
            this.roleLabel.string = `我的座位 ${mySeat >= 0 ? mySeat : "-"}  身份：${roleName(state.myRole)}`;
        }
        if (this.teamLabel) {
            this.teamLabel.string = `队长 ${state.captainSeat >= 0 ? state.captainSeat : "-"}  队伍：${state.selectedSeats.join(", ") || "未提交"}`;
        }
        if (this.visibleLabel) {
            this.visibleLabel.string = `当前选择：${this.selectedSeats.join(", ") || "无"}  可见座位：${state.visibleSeats.join(", ") || "无"}  连续否决：${state.failedVotes}`;
        }
        if (this.resultLabel) {
            this.resultLabel.string = state.stage === GameStage.End ? `结算：${state.isGoodWin ? "好人胜利" : "坏人胜利"} ${state.winReason}` : "";
        }
        if (this.logLabel) {
            this.logLabel.string = this.logLines.slice(-10).join("\n");
        }

        this.refreshMissionTrack();
        this.refreshSeats();
        this.refreshActionButtons();
    }

    private refreshMissionTrack(): void {
        const results = AvalonGameState.instance.missionResults;
        for (let i = 0; i < this.missionViews.length; i++) {
            const result = results[i];
            const color = result === undefined
                ? new Color(52, 56, 63, 255)
                : result
                    ? new Color(76, 127, 84, 255)
                    : new Color(145, 75, 72, 255);

            this.drawRect(this.missionViews[i].node, 82, 34, color, new Color(88, 91, 98, 255));
            this.missionViews[i].label.string = result === undefined ? `第${i + 1}局` : result ? "成功" : "失败";
        }
    }

    private refreshSeats(): void {
        const state = AvalonGameState.instance;
        for (let i = 0; i < this.seatViews.length; i++) {
            const view = this.seatViews[i];
            const player = state.getPlayerAtSeat(i);
            const selected = this.selectedSeats.indexOf(i) >= 0;
            const inTeam = state.selectedSeats.indexOf(i) >= 0;
            const isMe = Boolean(player && player.userId === state.myId);
            const isCaptain = i === state.captainSeat;
            const isVisible = state.visibleSeats.indexOf(i) >= 0;
            const color = this.seatColor(player, selected, inTeam, isMe, isCaptain, isVisible);

            this.drawRect(view.node, 118, 88, color, new Color(74, 82, 92, 255));
            view.label.string = this.seatText(i, player, isMe);
            view.mark.string = selected ? "已选" : isCaptain ? "队长" : inTeam ? "队伍" : isVisible ? "可见" : "";
        }
    }

    private refreshActionButtons(): void {
        const state = AvalonGameState.instance;

        this.setActive("propose", state.stage === GameStage.Proposing && state.isCaptain());
        this.setActive("voteApprove", state.stage === GameStage.Voting);
        this.setActive("voteReject", state.stage === GameStage.Voting);
        this.setActive("missionSuccess", state.stage === GameStage.Mission && (state.isMissionMember() || state.isLocalDemo));
        this.setActive("missionFail", state.stage === GameStage.Mission && (state.isMissionMember() || state.isLocalDemo));
        this.setActive("assassinate", state.stage === GameStage.Assassinating);
        this.setActive("clearSelection", this.selectedSeats.length > 0);
    }

    private seatColor(player: PlayerInfo | null, selected: boolean, inTeam: boolean, isMe: boolean, isCaptain: boolean, isVisible: boolean): Color {
        if (selected) {
            return new Color(176, 127, 52, 255);
        }
        if (isMe) {
            return new Color(48, 112, 111, 255);
        }
        if (isCaptain) {
            return new Color(57, 89, 134, 255);
        }
        if (inTeam) {
            return new Color(62, 105, 77, 255);
        }
        if (isVisible) {
            return new Color(91, 70, 120, 255);
        }
        if (player) {
            return new Color(43, 50, 61, 255);
        }

        return new Color(28, 31, 37, 255);
    }

    private seatText(seatIndex: number, player: PlayerInfo | null, isMe: boolean): string {
        if (!player) {
            return `${seatIndex}\n空位`;
        }

        const state = AvalonGameState.instance;
        const showRole = state.stage === GameStage.End || isMe || player.role !== Role.Unknown;
        const roleText = showRole ? `\n${roleName(player.role)}` : "";
        const tags = `${player.isReady ? "已准备" : "未准备"}${player.isAi ? " AI" : ""}${isMe ? " 我" : ""}`;

        return `${seatIndex} ${player.nickname || player.userId}\n${tags}${roleText}`;
    }

    private setActive(key: string, active: boolean): void {
        if (this.actionButtons[key]) {
            this.actionButtons[key].active = active;
        }
    }

    private connectionText(state: ConnectionState): string {
        switch (state) {
            case "open":
                return "已连接";
            case "connecting":
                return "连接中";
            case "error":
                return "错误";
            default:
                return "未连接";
        }
    }

    private addLog(message: string): void {
        const time = new Date().toLocaleTimeString();
        this.logLines.push(`[${time}] ${message}`);
        if (this.logLines.length > 40) {
            this.logLines.shift();
        }

        if (this.logLabel) {
            this.logLabel.string = this.logLines.slice(-10).join("\n");
        }
    }

    private createNode(parent: Node, name: string, x: number, y: number, width: number, height: number): Node {
        const node = new Node(name);
        parent.addChild(node);
        node.layer = parent.layer;
        node.setPosition(x, y);
        node.addComponent(UITransform).setContentSize(width, height);
        return node;
    }

    private createEditBox(parent: Node, name: string, x: number, y: number, width: number, height: number, value: string, placeholder: string): EditBox {
        const node = this.createNode(parent, name, x, y, width, height);
        this.drawRect(node, width, height, new Color(22, 25, 31, 255), new Color(87, 94, 104, 255));

        const editBox = node.addComponent(EditBox);
        const textLabel = this.createLabel(node, `${name}_Text`, "", 0, 0, width - 18, height - 8, 18, new Color(238, 239, 230, 255));
        const placeholderLabel = this.createLabel(node, `${name}_Placeholder`, placeholder, 0, 0, width - 18, height - 8, 18, new Color(126, 135, 145, 255));

        textLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        placeholderLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        editBox.textLabel = textLabel;
        editBox.placeholderLabel = placeholderLabel;
        editBox.string = value;
        editBox.placeholder = placeholder;
        editBox.maxLength = 64;
        return editBox;
    }

    private createButton(parent: Node, name: string, text: string, x: number, y: number, width: number, height: number, color: Color, callback: () => void): Node {
        const node = this.createNode(parent, name, x, y, width, height);
        this.drawRect(node, width, height, color, new Color(203, 197, 170, 255));
        node.addComponent(Button);
        node.on(Button.EventType.CLICK, callback, this);
        this.createLabel(node, `${name}_Label`, text, 0, 0, width - 10, height - 8, 19, new Color(247, 246, 236, 255));
        return node;
    }

    private createLabel(parent: Node, name: string, text: string, x: number, y: number, width: number, height: number, fontSize: number, color: Color): Label {
        const node = this.createNode(parent, name, x, y, width, height);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = Math.round(fontSize * 1.25);
        label.color = color;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;
        label.enableWrapText = true;
        return label;
    }

    private drawRect(node: Node, width: number, height: number, color: Color, strokeColor?: Color): void {
        let graphics = node.getComponent(Graphics);
        if (!graphics) {
            graphics = node.addComponent(Graphics);
        }

        graphics.clear();
        graphics.fillColor = color;
        graphics.rect(-width / 2, -height / 2, width, height);
        graphics.fill();

        if (strokeColor) {
            graphics.strokeColor = strokeColor;
            graphics.lineWidth = 2;
            graphics.rect(-width / 2, -height / 2, width, height);
            graphics.stroke();
        }
    }
}
