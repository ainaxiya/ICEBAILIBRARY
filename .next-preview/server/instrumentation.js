"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(() => {
var exports = {};
exports.id = "instrumentation";
exports.ids = ["instrumentation"];
exports.modules = {

/***/ "(instrument)/./src/instrumentation.ts":
/*!********************************!*\
  !*** ./src/instrumentation.ts ***!
  \********************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   register: () => (/* binding */ register)\n/* harmony export */ });\n// Next.js 服务启动钩子（S0-1 安全加固）\n// 生产环境关键安全变量缺失时直接 fail-fast，禁止以不安全默认值启动。\n// 开发环境不校验，保证本地零配置可跑。\nasync function register() {\n    if (false) {}\n    // S0-3：计费对账重试循环（settle/refund 失败的幂等兜底，60s 一轮；开发环境也运行便于本地验证）\n    try {\n        const { startBillingReconcileLoop } = await __webpack_require__.e(/*! import() */ \"_instrument_src_lib_gateway_billing-reconcile_ts-_instrument_src_lib_gateway_billing_ts\").then(__webpack_require__.bind(__webpack_require__, /*! ./lib/gateway/billing-reconcile */ \"(instrument)/./src/lib/gateway/billing-reconcile.ts\"));\n        startBillingReconcileLoop();\n    } catch (e) {\n        console.error(\"[instrumentation] billing-reconcile loop 启动失败\", e);\n    }\n    // M5：实验场媒体任务的重启恢复不放在这里——instrumentation 会被 edge 运行时二次编译，\n    // media-task-runner 依赖链带 node 内置模块（crypto/dns/net）会拖垮 edge 编译（同 P6 #20 教训）。\n    // 改挂在 /api/playground/tasks 路由模块加载时调度。\n    // P6 #20：BullMQ video worker 改为在 /v1/videos 路由模块加载时启动\n    // （video-queue 依赖 bullmq→pg，instrumentation 会被 edge 运行时二次编译吞不下 node 内置模块）\n    // S0-1：生产环境关键变量缺失 fail-fast（开发环境跳过，保证零配置可跑）\n    if (true) return;\n    const missing = [];\n    if (!process.env.JWT_SECRET) missing.push(\"JWT_SECRET\");\n    if (missing.length) {\n        throw new Error(`[security] Missing required env in production: ${missing.join(\", \")}. ` + `Refusing to start with insecure defaults.`);\n    }\n}\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKGluc3RydW1lbnQpLy4vc3JjL2luc3RydW1lbnRhdGlvbi50cyIsIm1hcHBpbmdzIjoiOzs7O0FBQUEsNEJBQTRCO0FBQzVCLHlDQUF5QztBQUN6QyxxQkFBcUI7QUFFZCxlQUFlQTtJQUNwQixJQUFJQyxLQUFxQyxFQUFFLEVBQU87SUFFbEQsNERBQTREO0lBQzVELElBQUk7UUFDRixNQUFNLEVBQUVHLHlCQUF5QixFQUFFLEdBQUcsTUFBTSxrUkFBeUM7UUFDckZBO0lBQ0YsRUFBRSxPQUFPQyxHQUFHO1FBQ1ZDLFFBQVFDLEtBQUssQ0FBQyxpREFBaURGO0lBQ2pFO0lBRUEseURBQXlEO0lBQ3pELDRFQUE0RTtJQUM1RSx1Q0FBdUM7SUFFdkMsc0RBQXNEO0lBQ3RELDBFQUEwRTtJQUUxRSw0Q0FBNEM7SUFDNUMsSUFBSUosSUFBcUMsRUFBRTtJQUUzQyxNQUFNTyxVQUFvQixFQUFFO0lBQzVCLElBQUksQ0FBQ1AsUUFBUUMsR0FBRyxDQUFDTyxVQUFVLEVBQUVELFFBQVFFLElBQUksQ0FBQztJQUMxQyxJQUFJRixRQUFRRyxNQUFNLEVBQUU7UUFDbEIsTUFBTSxJQUFJQyxNQUNSLENBQUMsK0NBQStDLEVBQUVKLFFBQVFLLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUN0RSxDQUFDLHlDQUF5QyxDQUFDO0lBRWpEO0FBQ0YiLCJzb3VyY2VzIjpbIkU6XFx0cmFleGlhbmdtdVxc5o+Q56S66K+NXFxDb21wbGV0ZVByb21wdFxcc3JjXFxpbnN0cnVtZW50YXRpb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gTmV4dC5qcyDmnI3liqHlkK/liqjpkqnlrZDvvIhTMC0xIOWuieWFqOWKoOWbuu+8iVxuLy8g55Sf5Lqn546v5aKD5YWz6ZSu5a6J5YWo5Y+Y6YeP57y65aSx5pe255u05o6lIGZhaWwtZmFzdO+8jOemgeatouS7peS4jeWuieWFqOm7mOiupOWAvOWQr+WKqOOAglxuLy8g5byA5Y+R546v5aKD5LiN5qCh6aqM77yM5L+d6K+B5pys5Zyw6Zu26YWN572u5Y+v6LeR44CCXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWdpc3RlcigpIHtcbiAgaWYgKHByb2Nlc3MuZW52Lk5FWFRfUlVOVElNRSAhPT0gXCJub2RlanNcIikgcmV0dXJuO1xuXG4gIC8vIFMwLTPvvJrorqHotLnlr7notKbph43or5Xlvqrnjq/vvIhzZXR0bGUvcmVmdW5kIOWksei0peeahOW5guetieWFnOW6le+8jDYwcyDkuIDova7vvJvlvIDlj5Hnjq/looPkuZ/ov5DooYzkvr/kuo7mnKzlnLDpqozor4HvvIlcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHN0YXJ0QmlsbGluZ1JlY29uY2lsZUxvb3AgfSA9IGF3YWl0IGltcG9ydChcIi4vbGliL2dhdGV3YXkvYmlsbGluZy1yZWNvbmNpbGVcIik7XG4gICAgc3RhcnRCaWxsaW5nUmVjb25jaWxlTG9vcCgpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltpbnN0cnVtZW50YXRpb25dIGJpbGxpbmctcmVjb25jaWxlIGxvb3Ag5ZCv5Yqo5aSx6LSlXCIsIGUpO1xuICB9XG5cbiAgLy8gTTXvvJrlrp7pqozlnLrlqpLkvZPku7vliqHnmoTph43lkK/mgaLlpI3kuI3mlL7lnKjov5nph4zigJTigJRpbnN0cnVtZW50YXRpb24g5Lya6KKrIGVkZ2Ug6L+Q6KGM5pe25LqM5qyh57yW6K+R77yMXG4gIC8vIG1lZGlhLXRhc2stcnVubmVyIOS+nei1lumTvuW4piBub2RlIOWGhee9ruaooeWdl++8iGNyeXB0by9kbnMvbmV077yJ5Lya5ouW5Z6uIGVkZ2Ug57yW6K+R77yI5ZCMIFA2ICMyMCDmlZnorq3vvInjgIJcbiAgLy8g5pS55oyC5ZyoIC9hcGkvcGxheWdyb3VuZC90YXNrcyDot6/nlLHmqKHlnZfliqDovb3ml7bosIPluqbjgIJcblxuICAvLyBQNiAjMjDvvJpCdWxsTVEgdmlkZW8gd29ya2VyIOaUueS4uuWcqCAvdjEvdmlkZW9zIOi3r+eUseaooeWdl+WKoOi9veaXtuWQr+WKqFxuICAvLyDvvIh2aWRlby1xdWV1ZSDkvp3otZYgYnVsbG1x4oaScGfvvIxpbnN0cnVtZW50YXRpb24g5Lya6KKrIGVkZ2Ug6L+Q6KGM5pe25LqM5qyh57yW6K+R5ZCe5LiN5LiLIG5vZGUg5YaF572u5qih5Z2X77yJXG5cbiAgLy8gUzAtMe+8mueUn+S6p+eOr+Wig+WFs+mUruWPmOmHj+e8uuWksSBmYWlsLWZhc3TvvIjlvIDlj5Hnjq/looPot7Pov4fvvIzkv53or4Hpm7bphY3nva7lj6/ot5HvvIlcbiAgaWYgKHByb2Nlc3MuZW52Lk5PREVfRU5WICE9PSBcInByb2R1Y3Rpb25cIikgcmV0dXJuO1xuXG4gIGNvbnN0IG1pc3Npbmc6IHN0cmluZ1tdID0gW107XG4gIGlmICghcHJvY2Vzcy5lbnYuSldUX1NFQ1JFVCkgbWlzc2luZy5wdXNoKFwiSldUX1NFQ1JFVFwiKTtcbiAgaWYgKG1pc3NpbmcubGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFtzZWN1cml0eV0gTWlzc2luZyByZXF1aXJlZCBlbnYgaW4gcHJvZHVjdGlvbjogJHttaXNzaW5nLmpvaW4oXCIsIFwiKX0uIGAgK1xuICAgICAgICBgUmVmdXNpbmcgdG8gc3RhcnQgd2l0aCBpbnNlY3VyZSBkZWZhdWx0cy5gXG4gICAgKTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbInJlZ2lzdGVyIiwicHJvY2VzcyIsImVudiIsIk5FWFRfUlVOVElNRSIsInN0YXJ0QmlsbGluZ1JlY29uY2lsZUxvb3AiLCJlIiwiY29uc29sZSIsImVycm9yIiwibWlzc2luZyIsIkpXVF9TRUNSRVQiLCJwdXNoIiwibGVuZ3RoIiwiRXJyb3IiLCJqb2luIl0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VSb290IjoiIn0=\n//# sourceURL=webpack-internal:///(instrument)/./src/instrumentation.ts\n");

/***/ }),

/***/ "@prisma/client":
/*!*********************************!*\
  !*** external "@prisma/client" ***!
  \*********************************/
/***/ ((module) => {

module.exports = require("@prisma/client");

/***/ })

};
;

// load runtime
var __webpack_require__ = require("./webpack-runtime.js");
__webpack_require__.C(exports);
var __webpack_exec__ = (moduleId) => (__webpack_require__(__webpack_require__.s = moduleId))
var __webpack_exports__ = (__webpack_exec__("(instrument)/./src/instrumentation.ts"));
module.exports = __webpack_exports__;

})();