#!/bin/sh
# Runs inside the ipfs/kubo container before the daemon starts (container-init.d hook).
# Bind the RPC API and gateway to all interfaces so the host can reach the mapped ports,
# and keep the node offline: the test only pins content it added itself.
set -e
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080
ipfs config --json Addresses.Swarm '[]'
ipfs config Routing.Type none
ipfs config --json Swarm.DisableNatPortMap true
ipfs config --json Discovery.MDNS.Enabled false
