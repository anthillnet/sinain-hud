package com.isinain.pipeline

import android.util.Log

/**
 * Simple structured logger matching iOS PipelineLogger.
 * Uses Android's Log.* with a consistent tag format.
 */
class PipelineLogger(private val subsystem: String) {
    private val tag = "ISinain.$subsystem"

    fun debug(msg: String) = Log.d(tag, msg)
    fun info(msg: String) = Log.i(tag, msg)
    fun warn(msg: String) = Log.w(tag, msg)
    fun error(msg: String) = Log.e(tag, msg)
    fun error(msg: String, t: Throwable) = Log.e(tag, msg, t)
}
