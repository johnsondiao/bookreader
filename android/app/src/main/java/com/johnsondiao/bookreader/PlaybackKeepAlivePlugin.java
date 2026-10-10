package com.johnsondiao.bookreader;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * 前端桥：播放开始时 start()（拉起前台服务），停止时 stop()。
 * 网页预览环境不会注册这个插件，前端调用侧已用 isNativePlatform 短路。
 */
@CapacitorPlugin(name = "PlaybackKeepAlive", permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
})
public class PlaybackKeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = bridge.getContext();
        ensureNotificationPermission();
        try {
            Intent i = new Intent(ctx, PlaybackService.class);
            if (Build.VERSION.SDK_INT >= 26) {
                ContextCompat.startForegroundService(ctx, i);
            } else {
                ctx.startService(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("start keep-alive failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Context ctx = bridge.getContext();
            ctx.stopService(new Intent(ctx, PlaybackService.class));
            call.resolve();
        } catch (Exception e) {
            call.reject("stop keep-alive failed: " + e.getMessage());
        }
    }

    /** Android 13+ 通知是运行时权限；不授权只是通知栏看不到，服务照常工作 */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            String p = Manifest.permission.POST_NOTIFICATIONS;
            if (ContextCompat.checkSelfPermission(getContext(), p) != PackageManager.PERMISSION_GRANTED) {
                bridge.getActivity().requestPermissions(new String[]{ p }, 20261);
            }
        } catch (Exception ignored) {
        }
    }
}
