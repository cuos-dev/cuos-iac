FROM debian:13.4

VOLUME ["/etc/ssh/keys", "/root"]
ENTRYPOINT ["/entrypoint.sh"]
WORKDIR /root

ENV container=docker

RUN apt-get -y update &&\
	DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
	# General \
	locales \
	# Editors and Session \
	vim nano git screen tmux less \
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
	&& rm -rf /var/lib/apt/lists/* \
	&& rm -f /etc/ssh/ssh_host_* \
	&& echo "en_US.UTF-8 UTF-8\nen_GB.UTF-8 UTF-8\nde_DE.UTF-8 UTF-8\nfr_FR.UTF-8 UTF-8\nes_ES.UTF-8 UTF-8\npt_BR.UTF-8 UTF-8\nja_JP.UTF-8 UTF-8" >/etc/locale.gen \
	&& update-alternatives --set editor /usr/bin/vim.basic \
	&& /usr/sbin/locale-gen

COPY entrypoint.sh /
COPY sshd_config_local.conf /etc/ssh/sshd_config.d/
COPY vimrc.local /etc/vim/
COPY gitconfig /etc/
COPY cuos cuos-* docker /usr/local/bin/
