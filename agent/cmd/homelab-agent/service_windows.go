package main

import (
	"context"
	"errors"
	"flag"
	"golang.org/x/sys/windows/svc"
)

type serviceHandler struct{ args []string }

func (h serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	status <- svc.Status{State: svc.StartPending}
	go func() { done <- runCommand(ctx, h.args) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case e := <-done:
			if e != nil {
				return true, 1
			}
			return false, 0
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				if e := <-done; e != nil {
					return true, 1
				}
				return false, 0
			}
		}
	}
}
func runService(args []string) error {
	fs := flag.NewFlagSet("service", flag.ContinueOnError)
	name := fs.String("name", "", "installed service name")
	mode := fs.String("mode", "", "supervisor or connect")
	config := fs.String("config", "", "protected config JSON")
	if e := fs.Parse(args); e != nil {
		return e
	}
	if *name == "" || (*mode != "supervisor" && *mode != "connect") || *config == "" {
		return errors.New("service_name_mode_config_required")
	}
	return svc.Run(*name, serviceHandler{[]string{*mode, "--config", *config}})
}
