@echo off
title LMS Assistant - Cron Automation Runner
echo Starting LMS Assistant Automation Service...
node scripts/cron-worker.mjs
pause

