package com.johnsondiao.bookreader;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 「所有文件访问权限」（MANAGE_EXTERNAL_STORAGE）检测与跳转。
 *
 * 背景：Android 11+ 分区存储下，普通运行时权限无法让 App 用 File API
 * 读写公共 Documents 目录；音频资产存于共享 Documents（卸载不丢），
 * 必须授予该特殊权限才能扫描/恢复历史音频。
 *
 * 本插件只做两件事：
 *  - isManager：查询 Environment.isExternalStorageManager()
 *  - requestManager：跳转到系统的「所有文件访问权限」设置页（无法静默授权）
 *
 * Android 10 及以下走常规存储权限（@capacitor/filesystem 自带），恒返回 granted。
 */
@CapacitorPlugin(name = "AllFilesAccess")
public class AllFilesAccessPlugin extends Plugin {

    @PluginMethod
    public void isManager(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.R
                || Environment.isExternalStorageManager();
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestManager(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        if (Environment.isExternalStorageManager()) {
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        boolean opened = false;
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            opened = true;
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                getActivity().startActivity(fallback);
                opened = true;
            } catch (Exception ignored) {
                /* 个别 ROM 两个入口都打不开，交给前端提示 */
            }
        }
        ret.put("granted", Environment.isExternalStorageManager());
        ret.put("openedSettings", opened);
        call.resolve(ret);
    }
}
