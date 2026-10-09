import pytest

from error_codes import extract

# Each text below is a real Issue note from Spirit Web DB.
CASES = [
    ("Other, UNIT HAS AN E5 ERROR ON THE SCREEN.", ["E5"]),
    ("tech replaced controller still getting E-4 message tested motor", ["E4"]),
    ("Gen. Help, E2 and E7 errors. Per tech send out parts", ["E2", "E7"]),
    ("Gen. Help, E50H error oob.", ["E50H"]),
    ("E 10-H. Motor does not move - ran calibration", ["E10H"]),
    ("Gen. Help, E5oob", ["E5"]),
    ("still getting E5error", ["E5"]),
    ("e5s and e7s errors", ["E5", "E7"]),
    ("Noise, Other, Code E02 With a noise from the motor area", ["E2"]),
    ("Gen. Help, Ground fault error E 13", ["E13"]),
    ("Gen. Help, has E22R-54485 flt error,oob issue per dealer", ["E22"]),
    ("ERROR 5 ON THE DISPLAY SCREEN, UNIT WILL NOT RESPOND", ["E5"]),
    ("STILL HAVING ERR-6.", ["E6"]),
    ("E7 ERR0R AFTER VISIT FROM LAST TECH", ["E7"]),
    ("HE IS STILL GETTING A LS ERROR WITH BELT MVMNT.", ["LS"]),
    ("TREADMILL STOPS SUDDENLY AFTER STARTING UP AND READS LS1 ERROR", ["LS1"]),
    ("Get error message LSI. sometimes the belt will move", ["LS1"]),
    ("LS ERROR 30 MINUTES INTO WORK OUT.", ["LS"]),
    ("LS ERROR 8 SECONDS IN.", ["LS"]),
    ("LS 20 minutes into workout.", ["LS"]),
    ("THE TREADMILL GIVES A LOW SPEED ERROR", ["LS"]),
    ("Unit has ls error after a few seconds.", ["LS"]),
    ("Machine is giving an ls1 error code.", ["LS1"]),
    # Model names, not error codes.
    ("CONSOLE THAT WAS SENT IS FOR AN E35. NEEDS NEW CONSOLE", []),
    ("ADDITIONAL LUBRICANT FOR THE RAILS OF HIS E95 ELLIPTICAL.", []),
    ("in struts coming out of the neck of the E95S model.", []),
    ("Other, E 20 Right foot Cap broke need replacement cap", []),
    ("Sending: ADJUST.PIN,XE350/550,E55/75/95", []),
    ("Gen. Help, E-25H error.", ["E25H"]),
    ("Seat Issue, The LSF handle is not working properly", []),
    ("RECEIVED WRONG PART, E-MAILING PHOTOS OF PART HE NEEDS", []),
    ("machine is giving no error codes", []),
]


@pytest.mark.parametrize("text,expected", CASES)
def test_extract(text, expected):
    assert extract(text) == expected
