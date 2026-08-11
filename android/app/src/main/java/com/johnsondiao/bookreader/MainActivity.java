package com.johnsondiao.bookreader;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件：「所有文件访问权限」检测与跳转（Android 11+ 读公共 Documents 必需）
        registerPlugin(AllFilesAccessPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
