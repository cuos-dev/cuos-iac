#!/bin/bash

# Update certificates:
update-ca-certificates

# Create SSH host keys:
KEY_DIR="/etc/ssh/keys"
SSH_DIR="/etc/ssh"
if [ -f "${KEY_DIR}/ssh_host_rsa_key" ]; then
	echo "Using existing SSH host keys from volume..."
	cp "${KEY_DIR}"/ssh_host_* "${SSH_DIR}/"
else
	echo "Generating new SSH host keys..."
	ssh-keygen -A
	cp "${SSH_DIR}"/ssh_host_* "${KEY_DIR}"/
fi

# Add firewall rule for ssh
iptables -I INPUT -p tcp --dport 3522 -j ACCEPT


# Add ssh keys:
mkdir -p /root/.ssh
chmod 700 /root/.ssh

KEYS=$(jq -r '.["dev-keys"][]' "/system.json")
echo -n >/root/.ssh/authorized_keys
if [ -z "$KEYS" ]; then
    echo "Warning: No keys provided. Set key \"dev-keys\"."
else
    echo "$KEYS" >>/root/.ssh/authorized_keys
fi

# Start ssh daemon
mkdir -p /run/sshd

exec /usr/sbin/sshd -D

