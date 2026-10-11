# hermans-hornpipe.webp: gemini-3.5-flash, 2026-10-11

Whole page per request (LINES_PER_REQUEST 8), low thinking, measured note heads as hints, up to two double-check rounds. 13 requests including retries after "busy" replies; 8.6 minutes (Gemini was overloaded).

## With pitch snapped to the measured note heads (current pipeline, same recorded replies)

```
FIRST READ: pitch 71.4%, rhythm 34.6% (note lengths 67.6%); key ok, time ok, pickup bar has different notes; bars 23/22
bar  notes  pitch   rhythm  lengths
  0      1      0%      0%      0%  (missing)
  1     16    100%    100%    100%
  2     16   87.5%     25%   87.5%
  3     16   93.8%   87.5%   93.8%
  4     16   68.8%      0%   56.3%
  5     16    100%    100%    100%
  6     16   87.5%     25%   87.5%
  7     16   81.3%   62.5%   81.3%
  8     18   66.7%      0%   55.6%
  9     16   62.5%    6.3%   62.5%
 10     18   55.6%   38.9%     50%
 11     16   56.3%      0%   56.3%
 12     18   55.6%      0%   33.3%
 13     15   56.3%   33.3%     60%
 14     18   33.3%   11.1%   27.8%
 15     15   62.5%    6.7%   66.7%
 16     14   42.9%    7.1%   35.7%
 17     16   93.8%   87.5%   93.8%
 18     16   87.5%     25%   87.5%
 19     16   93.8%   87.5%   93.8%
 20     15   66.7%      0%   46.7%
 21      3      0%      0%      0%  (uncertain, not counted)  (missing)
 +0      0      0%      0%      0%

AFTER CHECK: pitch 70.8%, rhythm 34.9% (note lengths 65.4%); key ok, time ok, pickup bar has different notes; bars 23/22
bar  notes  pitch   rhythm  lengths
  0      1      0%      0%      0%  (missing)
  1     16    100%    100%    100%
  2     16   87.5%     25%   87.5%
  3     16   93.8%   87.5%   93.8%
  4     16   68.8%      0%   56.3%
  5     16    100%    100%    100%
  6     16   87.5%     25%   87.5%
  7     16   81.3%   62.5%   81.3%
  8     18   77.8%      0%   55.6%
  9     16   43.8%     25%   43.8%
 10     18   55.6%   38.9%     50%
 11     16   56.3%      0%   56.3%
 12     18   55.6%      0%   33.3%
 13     15     50%   33.3%   53.3%
 14     18   38.9%   11.1%   22.2%
 15     15   43.8%      0%   46.7%
 16     14     50%      0%   42.9%
 17     16   93.8%   87.5%   93.8%
 18     16   87.5%     25%   87.5%
 19     16   93.8%   87.5%   93.8%
 20     15   73.3%      0%   46.7%
 21      3      0%      0%      0%  (uncertain, not counted)  (missing)
 +0      0      0%      0%      0%
```

## As recorded live (before snapping)

```
FIRST READ: pitch 69.6%, rhythm 34.3% (note lengths 66.4%); key ok, time ok, pickup bar has different notes; bars 23/22
bar  notes  pitch   rhythm  lengths
  0      1      0%      0%      0%  (missing)
  1     16    100%    100%    100%
  2     16   87.5%     25%   87.5%
  3     16   93.8%   87.5%   93.8%
  4     16   68.8%      0%   56.3%
  5     16    100%    100%    100%
  6     16   87.5%     25%   87.5%
  7     16   81.3%   62.5%   81.3%
  8     18   66.7%      0%   55.6%
  9     16   56.3%    6.3%   56.3%
 10     18   55.6%   38.9%     50%
 11     16   56.3%      0%   56.3%
 12     18   44.4%      0%   27.8%
 13     15   56.3%   33.3%     60%
 14     18   33.3%   11.1%   27.8%
 15     15   62.5%    6.7%   66.7%
 16     14   42.9%   14.3%   35.7%
 17     16   93.8%   87.5%   93.8%
 18     16   87.5%     25%   87.5%
 19     16   81.3%     75%   81.3%
 20     15     60%      0%   46.7%
 21      3      0%      0%      0%  (uncertain, not counted)  (missing)
 +0      0      0%      0%      0%

bar  notes  pitch   rhythm  lengths
AFTER CHECK: pitch 69%, rhythm 34.3% (note lengths 64.5%); key ok, time ok, pickup bar has different notes; bars 23/22
  0      1      0%      0%      0%  (missing)
  1     16    100%    100%    100%
  2     16   87.5%     25%   87.5%
  3     16   93.8%   87.5%   93.8%
  4     16   68.8%      0%   56.3%
  5     16    100%    100%    100%
  6     16   87.5%     25%   87.5%
  7     16   81.3%   62.5%   81.3%
  8     18   72.2%      0%   55.6%
  9     16   43.8%     25%   43.8%
 10     18   55.6%   38.9%     50%
 11     16   56.3%      0%   56.3%
 12     18   44.4%      0%   27.8%
 13     15     50%   33.3%   53.3%
 14     18   38.9%   11.1%   22.2%
 15     15   43.8%      0%   46.7%
 16     14     50%      0%   42.9%
 17     16   93.8%   87.5%   93.8%
 18     16   87.5%     25%   87.5%
 19     16   81.3%     75%   81.3%
 20     15   66.7%      0%   46.7%
 21      3      0%      0%      0%  (uncertain, not counted)  (missing)
 +0      0      0%      0%      0%
```
