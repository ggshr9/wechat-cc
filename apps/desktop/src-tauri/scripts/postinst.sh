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

restart_for_user() {
    user=$1
    home_dir=$2
    [ -f "$home_dir/.config/systemd/user/wechat-cc.service" ] || return 0
    uid=$(id -u "$user" 2>/dev/null) || return 0
    # systemctl --user needs the user's runtime dir to reach their dbus.
    # Absent → user not logged in; service will pick up the new binary on
    # their next login when systemd starts the unit fresh.
    [ -d "/run/user/$uid" ] || return 0
    runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" \
        systemctl --user try-restart wechat-cc.service >/dev/null 2>&1
}

for home_dir in /home/*; do
    [ -d "$home_dir" ] || continue
    user=$(basename "$home_dir")
    restart_for_user "$user" "$home_dir"
done
restart_for_user root /root

exit 0
