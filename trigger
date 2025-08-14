#!/bin/bash

INPUT="$(cat)"

COMMAND="$(jq -r '.app_command // empty' <<< "${INPUT}")"

if [[ "${COMMAND}" = "" || "${COMMAND}" = "help" || "${COMMAND}" = "--help" ]]; then
  cat <<EOF
USAGE: cuos-iac ACTION

ACTIONS:
EOF

  grep -E "^##" "${BASH_SOURCE[0]}" | sed -e 's/^## \?//'

  echo

## update             - Trigger update of the IaC definitions
elif [[ "${COMMAND}" = "update" ]]; then
	killall sleep

## ps                 - Show docker ps as JSON
elif [[ "${COMMAND}" = "ps" ]]; then
	docker ps --format '{{json .}}' | jq -s .
	#COMPOSE_PROJECT_NAME="iac" docker-compose -f /volume/repo/docker-compose.yml ps --format '{{json .}}'

## state              - Provide IaC state
elif [[ "${COMMAND}" = "state" ]]; then
	cat /tmp/state.json

else
	echo "No valid command provided. Exiting."

fi
