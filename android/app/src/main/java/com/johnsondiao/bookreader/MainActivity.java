package com.johnsondiao.bookreader;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件：「所有文件访问权限」检测与跳转（Android 11+ 读公共 Documents 必需）
        registerPlugin(AllFilesAccessPlugin.class);
        // 本地神经网络 TTS（sherpa-onnx 原生推理，免流量免扣费）
        registerPlugin(LocalTtsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
