#!/bin/sh
# Restart any running wechat-cc daemon so a freshly installed binary takes
# effect immediately. Linux lets dpkg replace /usr/bin/wechat-cc-cli while
# the running daemon keeps the old (now-deleted) inode mapped — without
# this script, users see "I just upgraded but nothing changed" until they
# manually restart the service.
#
# Targets daemons registered via `wechat-cc service install` (systemd
# --user unit at ~/.config/systemd/user/wechat-cc.service). Daemons started
# manually (e.g. `wechat-cc run` in a terminal) are not auto-restarted —
# we don't kill arbitrary user processes from postinst.
#
# Best-effort: every error path is swallowed; always exits 0 so a stuck
# user session can't block dpkg.

set +e

# `runuser -u USER -- env ... cmd` is the Debian-stable way; older util-linux
# (RHEL 7, Debian 9 LTS) and rpm %post environments may not have runuser at
# all (or it's at /sbin/runuser which isn't always on PATH). `su -s /bin/sh
# -c '…' USER` is the POSIX-portable fallback.
restart_for_user() {
    user=$1
    home_dir=$2
    [ -f "$home_dir/.config/systemd/user/wechat-cc.service" ] || return 0
    uid=$(id -u "$user" 2>/dev/null) || return 0
    # systemctl --user needs the user's runtime dir to reach their dbus.
    # Absent → user not logged in; service will pick up the new binary on
    # their next login when systemd starts the unit fresh.
    [ -d "/run/user/$uid" ] || return 0
    cmd="XDG_RUNTIME_DIR=/run/user/$uid systemctl --user try-restart wechat-cc.service"
    if command -v runuser >/dev/null 2>&1; then
        runuser -u "$user" -- sh -c "$cmd" >/dev/null 2>&1
    else
        su -s /bin/sh -c "$cmd" "$user" >/dev/null 2>&1
    fi
}

# Enumerate users via `getent passwd` rather than globbing /home/*. Globbing
# is unreliable in rpm %post (the shell may be dash, NULLGLOB may be off,
# and "/home/*" can stay literal). getent reads nsswitch and returns every
# real user including ones whose home dirs live outside /home (LDAP users,
# /var/lib/* service accounts, etc.). Filter to UIDs >= 1000 to skip system
# accounts.
if command -v getent >/dev/null 2>&1; then
    getent passwd | while IFS=: read -r user _ uid _ _ home _; do
        [ "$uid" -ge 1000 ] 2>/dev/null || continue
        [ -d "$home" ] || continue
        restart_for_user "$user" "$home"
    done
fi
restart_for_user root /root

exit 0
