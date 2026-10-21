# Isolated component test only. Do not publish this password-auth fixture.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10000 --no-create-home --shell /usr/sbin/nologin sftpfixture \
    && printf 'sftpfixture:isolated-fixture-only\n' | chpasswd \
    && mkdir -p /run/sshd /srv/fixture-jail/data \
    && chown 10000:10000 /srv/fixture-jail/data \
    && printf 'homelab-isolated-sftp-root\n' >/srv/fixture-jail/root-marker \
    && printf 'outside-the-chroot\n' >/outside-root-canary \
    && chmod 644 /srv/fixture-jail/root-marker /outside-root-canary \
    && printf 'Port 2222\nHostKey /etc/ssh/ssh_host_ed25519_key\nPasswordAuthentication yes\nUsePAM no\nPermitRootLogin no\nKbdInteractiveAuthentication no\nSubsystem sftp internal-sftp\nMatch User sftpfixture\n ChrootDirectory /srv/fixture-jail\n ForceCommand internal-sftp\n AllowTcpForwarding no\n X11Forwarding no\n PermitTunnel no\n PermitTTY no\n' >/etc/ssh/sshd_config
EXPOSE 2222
CMD ["/usr/sbin/sshd","-D","-e"]
