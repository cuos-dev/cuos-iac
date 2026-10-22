# SPDX-License-Identifier: Apache-2.0
FROM debian:13.7

VOLUME ["/etc/ssh/keys", "/root"]
ENTRYPOINT ["/entrypoint.sh"]
WORKDIR /root

ENV container=docker

RUN apt-get -y update &&\
	DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
	# General \
	locales bash-completion \
	# Editors and Session \
	vim nano git screen tmux less \
	# System and Processes \
	htop procps psmisc lsof strace sysstat iotop \
	# Network \
	iproute2 dnsutils iputils-ping traceroute net-tools tcpdump \
	netcat-openbsd nmap curl wget ethtool openssh-client iptables iftop \
	cifs-utils socat mtr-tiny \
	# Languages & dev tools \
	python3 python3-pip nodejs npm make shellcheck \
	man manpages \
	# Converter & Formats, like JSON etc \
	jq python3-jsonschema libdata-hexdump-perl bzip2 zip unzip \
	# Files \
	tree ncdu pv ripgrep rsync \
	# Docker \
	docker-cli docker-compose \
	# Servers \
	openssh-server cron \
	&& rm -rf /var/lib/apt/lists/* \
	&& rm -f /etc/ssh/ssh_host_* \
	&& echo "en_US.UTF-8 UTF-8\nen_GB.UTF-8 UTF-8\nde_DE.UTF-8 UTF-8\nfr_FR.UTF-8 UTF-8\nes_ES.UTF-8 UTF-8\npt_BR.UTF-8 UTF-8\nja_JP.UTF-8 UTF-8" >/etc/locale.gen \
	&& update-alternatives --set editor /usr/bin/vim.basic \
	# Debian loads it for login shells only; docker exec and screen start non-login ones \
	&& echo '. /etc/profile.d/bash_completion.sh' >>/etc/bash.bashrc \
	# On the /root volume, so crontabs survive a new container. cron refuses a \
	# symlinked crontab file, but follows a symlinked directory \
	&& rm -rf /var/spool/cron/crontabs \
	&& ln -s /root/.crontabs /var/spool/cron/crontabs \
	&& /usr/sbin/locale-gen

COPY entrypoint.sh /
COPY sshd_config_local.conf /etc/ssh/sshd_config.d/
COPY vimrc.local /etc/vim/
COPY gitconfig /etc/
COPY cuos cuos-* docker docker-compose /usr/local/bin/
