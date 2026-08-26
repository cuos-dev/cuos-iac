#!/bin/bash
# SPDX-License-Identifier: Apache-2.0

export CUOS_SYSTEM_JSON="./local-test.system.json"
export FLEET_SERVER_URL="ws://localhost:8085"
export FLEET_SECRET="changeme"
export FLEET_UUID_FILE="./local-test.state_fleet_uuid"

node ./agent.js
