package com.johnsondiao.bookreader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * 朗读保活前台服务。
 *
 * 病因：App 之前没有任何后台保活，息屏后系统省电机制把 WebView 的音频链路
 * 掐掉（长播放必现）。修法：播放期间挂一个 mediaPlayback 类型的前台服务 +
 * 常驻通知，系统就不再杀我们的音频。
 *
 * 附带一个活跃的 MediaSession：Android 14+ 对 mediaPlayback 类型前台服务
 * 要求「启动时确实在播音频」（有活跃 MediaSession 是系统认可的证据），
 * 没有它部分机型上 startForeground 会直接抛异常。
 */
public class PlaybackService extends Service {

    private static final String CHANNEL_ID = "langyue_playback";
    private static final int NOTIFICATION_ID = 2026;

    private MediaSession session;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        startInForeground();
        return START_STICKY;
    }

    private void startInForeground() {
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.app_name))
                .setContentText("正在朗读，息屏也继续播放")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Exception e) {
            // 个别深度定制系统对类型校验更严：退化为普通 startForeground，至少服务活着
            try {
                startForeground(NOTIFICATION_ID, n);
            } catch (Exception ignored) {
            }
        }
        acquireMediaSession();
    }

    /** Android 14+ 要求 mediaPlayback 前台服务有「确实在播」的证据 */
    private void acquireMediaSession() {
        if (session != null) return;
        try {
            session = new MediaSession(this, "LangyuePlayback");
            session.setPlaybackState(new PlaybackState.Builder()
                    .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                    .build());
            session.setActive(true);
        } catch (Exception ignored) {
            session = null;
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "朗读播放", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("息屏时保持朗读继续");
                ch.setSound(null, null);
                nm.createNotificationChannel(ch);
            }
        }
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            try {
                session.setActive(false);
                session.release();
            } catch (Exception ignored) {
            }
            session = null;
        }
        super.onDestroy();
    }
}
