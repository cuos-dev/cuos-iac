FROM debian:trixie

VOLUME ["/etc/ssh/keys", "/root"]
ENTRYPOINT ["/entrypoint.sh"]
WORKDIR /root

COPY entrypoint.sh /
COPY sshd_config_local.conf /etc/ssh/sshd_config.d/
COPY vimrc.local /etc/vim/
COPY gitconfig /etc/
COPY cuos /usr/bin/

ENV container=docker

RUN apt-get -y update &&\
	DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
	# Editors and Session \
	vim nano git screen tmux \
	# System and Processes \
	htop procps lsof strace sysstat iotop \
	# Network \
	iproute2 dnsutils iputils-ping traceroute net-tools tcpdump \
	netcat-openbsd nmap curl wget ethtool openssh-client iptables iftop \
	cifs-utils smbclient socat \
	# Languages & dev tools \
	python3 python3-pip nodejs npm make shellcheck gdb \
	man manpages \
	# Converter & Formats, like JSON etc \
	jq python3-jsonschema libdata-hexdump-perl bzip2 \
	# Docker \
	docker-cli docker-compose \
	# Others \
	gnupg2 cron pandoc \
	# Servers \
	openssh-server \
	&& rm -rf /var/lib/apt/lists/*

