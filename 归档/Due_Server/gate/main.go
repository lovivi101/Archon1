package main

import (
	"github.com/dobyte/due"
	"github.com/dobyte/due/cluster/gate"
	"github.com/dobyte/due/locate/redis"
	"github.com/dobyte/due/network/ws"
	"github.com/dobyte/due/registry/etcd"
	"github.com/dobyte/due/transport/grpc"
)

func main() {
	container := due.NewContainer()
	server := ws.NewServer(ws.WithServerListenAddr(":8888"))
	locator := redis.NewLocator()
	registry := etcd.NewRegistry()
	transporter := grpc.NewTransporter()

	gateComponent := gate.NewGate(
		gate.WithServer(server),
		gate.WithLocator(locator),
		gate.WithRegistry(registry),
		gate.WithTransporter(transporter),
	)
	container.Add(gateComponent)
	container.Serve()
}
