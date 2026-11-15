"""Execute the real manager class with fake HA service/state boundaries."""
import ast
import asyncio
import logging
import time
import unittest
from typing import Optional, Any
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

source = Path(__file__).resolve().parents[1] / "custom_components/thermostat_timeline/__init__.py"
tree = ast.parse(source.read_text(encoding="utf-8"))
manager = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "AutoApplyManager")
namespace = dict(HomeAssistant=object, Optional=Optional, Any=Any, _norm_instance_id=lambda x:x, DOMAIN="thermostat_timeline",
    asyncio=asyncio, _LOGGER=logging.getLogger(__name__),
    time=time,
    UnitOfTemperature=SimpleNamespace(FAHRENHEIT="F"),
    dt_util=SimpleNamespace(utcnow=lambda:datetime.now(timezone.utc)))
exec(compile(ast.Module(body=[manager], type_ignores=[]), str(source), "exec"), namespace)
Manager = namespace["AutoApplyManager"]

class AutoApplyTests(unittest.IsolatedAsyncioTestCase):
    def make(self, settings, state="off", attrs=None):
        entity = SimpleNamespace(state=state, attributes=attrs or {"hvac_modes":["off","heat"], "temperature":13})
        self.call = AsyncMock()
        states = {"climate.room":entity, "binary_sensor.summer":SimpleNamespace(state="on")}
        hass = SimpleNamespace(states=SimpleNamespace(get=states.get), services=SimpleNamespace(async_call=self.call),
            config=SimpleNamespace(units=SimpleNamespace(temperature_unit="C")),
            data={"thermostat_timeline":{"settings":settings,"schedules":{"climate.room":{}}}})
        return Manager(hass)

    async def test_disabled_turn_on_leaves_off_thermostat_off(self):
        mgr = self.make({"turn_on":{"climate.room":{"enabled":False}}})
        self.assertTrue(await mgr._apply_setpoint("climate.room",20))
        self.assertEqual([c.args[1] for c in self.call.await_args_list],["set_temperature"])

    async def test_enabled_turn_on_before_and_after_preserve_order(self):
        for order in ("before","after"):
            mgr = self.make({"turn_on":{"climate.room":{"enabled":True,"order":order}},"turn_on_delay_s":0})
            self.assertTrue(await mgr._apply_setpoint("climate.room",20))
            names = [c.args[1] for c in self.call.await_args_list]
            self.assertIn("set_hvac_mode",names)
            self.assertLess(names.index("set_hvac_mode"),names.index("set_temperature")) if order=="before" else self.assertGreater(names.index("set_hvac_mode"),names.index("set_temperature"))

    async def test_pause_sensor_blocks_timer_even_when_forced(self):
        mgr = self.make({"auto_apply_enabled":True,"pause_sensor_enabled":True,"pause_sensor_entity":"binary_sensor.summer"})
        await mgr._maybe_apply_now(force=True)
        await mgr.async_apply_entity_now("climate.room",reconcile=True)
        self.call.assert_not_awaited()
        self.assertFalse(mgr._auto_apply_enabled())

    async def test_boost_is_overridden_by_scheduled_manual_preset(self):
        mgr = self.make({},state="heat",attrs={"hvac_modes":["heat"],"preset_modes":["boost","manual"],"preset_mode":"boost"})
        self.assertTrue(await mgr._apply_setpoint("climate.room",20))
        self.assertEqual(self.call.await_args_list[0].args[2]["preset_mode"],"manual")

    async def test_explicit_modes_have_safe_command_order(self):
        mgr = self.make({}, state="heat")
        self.assertTrue(await mgr._apply_setpoint("climate.room", 0, requested_mode="off"))
        self.assertEqual([call.args[1] for call in self.call.await_args_list], ["set_hvac_mode"])
        self.assertEqual(self.call.await_args.args[2]["hvac_mode"], "off")
        mgr = self.make({"turn_on":{"climate.room":{"enabled":False}}})
        self.assertTrue(await mgr._apply_setpoint("climate.room", 21, requested_mode="heat"))
        self.assertEqual([call.args[1] for call in self.call.await_args_list], ["set_temperature", "set_hvac_mode"])
        self.assertEqual(self.call.await_args_list[0].args[2]["temperature"], 21)

    async def test_mode_boundaries_gap_and_restart_reconciliation(self):
        mgr = self.make({"auto_apply_enabled":True}, state="heat")
        row = {"defaultTemp":17, "defaultMode":"off", "blocks":[
            {"startMin":60,"endMin":120,"temp":21,"hvacMode":"heat"},
            {"startMin":120,"endMin":180,"hvacMode":"off"}]}
        schedules = mgr.hass.data["thermostat_timeline"]["schedules"]
        schedules["climate.room"] = row
        settings = mgr.hass.data["thermostat_timeline"]["settings"]
        self.assertEqual(mgr._desired_action_for("climate.room",schedules,settings,60),{"hvacMode":"heat","temperature":21})
        self.assertEqual(mgr._desired_action_for("climate.room",schedules,settings,120),{"hvacMode":"off","temperature":None})
        self.assertEqual(mgr._desired_action_for("climate.room",schedules,settings,180),{"hvacMode":"off","temperature":None})
        mgr._now_min = lambda:120
        await mgr._maybe_apply_now(boundary_only=True)
        self.assertEqual([call.args[1] for call in self.call.await_args_list],["set_hvac_mode"])
        self.call.reset_mock()
        await mgr._maybe_apply_now()
        self.call.assert_not_awaited()
        restarted = self.make({"auto_apply_enabled":True},state="heat")
        restarted.hass.data["thermostat_timeline"]["schedules"]["climate.room"] = row
        restarted._now_min = lambda:150
        await restarted._maybe_apply_now(reconcile=True)
        self.assertEqual(self.call.await_args.args[2]["hvac_mode"],"off")

    async def test_one_day_holiday_heat_expires_without_repeating(self):
        mgr = self.make({"weekdays_enabled":True,"holidays_enabled":True,
            "holidays_source":"manual","holidays_dates":["2026-11-15"]})
        mgr._today_key = lambda:"sun"
        mgr._today_iso = lambda:"2026-11-15"
        row = {"defaultTemp":20.5,"defaultMode":"off","blocks":[],
            "weekly":{"mode":"all_7","days":{"sun":[]}},
            "holiday":{"blocks":[{"startMin":375,"endMin":1140,"temp":20.5,"hvacMode":"heat"}]}}
        schedules = {"climate.room":row}
        settings = mgr.hass.data["thermostat_timeline"]["settings"]
        for minute, mode in ((374,"off"),(375,"heat"),(1139,"heat"),(1140,"off")):
            self.assertEqual(mgr._desired_action_for("climate.room",schedules,settings,minute)["hvacMode"],mode)
        mgr._today_iso = lambda:"2026-11-22"
        self.assertEqual(mgr._desired_action_for("climate.room",schedules,settings,375)["hvacMode"],"off")
        ordinary = {"defaultMode":"off","weekly":{"mode":"all_7","days":{"sun":[
            {"startMin":1020,"endMin":1140,"temp":26.5,"hvacMode":"heat"}]}}}
        mgr._today_iso = lambda:"2026-11-15"
        self.assertEqual(mgr._effective_blocks_today(ordinary,settings),ordinary["weekly"]["days"]["sun"])

    async def test_explicit_mode_respects_disabled_room(self):
        mgr = self.make({"apply_enabled":{"climate.room":False}},state="heat")
        self.assertFalse(await mgr._apply_setpoint("climate.room",0,requested_mode="off"))
        self.call.assert_not_awaited()

    async def test_mode_only_boundary_and_merged_room_pause(self):
        mgr = self.make({"auto_apply_enabled":True,"merges":{"climate.room":["climate.secondary"]}},state="off")
        row = {"defaultTemp":17,"blocks":[{"startMin":60,"endMin":120,"temp":21,"hvacMode":"heat"}]}
        schedules = mgr.hass.data["thermostat_timeline"]["schedules"]
        schedules["climate.room"] = row
        settings = mgr.hass.data["thermostat_timeline"]["settings"]
        self.assertEqual(mgr._desired_action_for("climate.secondary",schedules,settings,60),{"hvacMode":"heat","temperature":21})
        mgr._now_min = lambda:60
        mgr.hass.states.get("climate.room").attributes["temperature"] = 21
        await mgr._maybe_apply_now(boundary_only=True)
        self.assertEqual(self.call.await_args.args[2]["hvac_mode"],"heat")
        self.call.reset_mock()
        settings["room_pause"] = {"climate.room":{"indef":True}}
        self.assertFalse(await mgr._apply_setpoint("climate.secondary",0,requested_mode="off"))
        self.call.assert_not_awaited()

    async def test_failed_heat_command_never_enables_or_caches(self):
        mgr = self.make({"auto_apply_enabled":True},state="off")
        mgr.hass.data["thermostat_timeline"]["schedules"]["climate.room"] = {"blocks":[{"startMin":0,"endMin":1440,"temp":21,"hvacMode":"heat"}]}
        mgr._now_min = lambda:60
        self.call.side_effect = RuntimeError("simulated service failure")
        await mgr._maybe_apply_now()
        self.assertEqual([call.args[1] for call in self.call.await_args_list],["set_temperature"])
        self.assertNotIn("climate.room",mgr._last_applied)
        self.call.side_effect = None
        await mgr._maybe_apply_now()
        self.assertEqual(mgr._last_applied["climate.room"]["hvacMode"],"heat")

    async def test_entity_patch_persists_and_clears_default_mode(self):
        mgr = self.make({})
        mgr.hass.data["thermostat_timeline"]["version"] = 1
        patch_function = next(node for node in ast.walk(tree) if isinstance(node,ast.AsyncFunctionDef) and node.name == "patch_entity")
        scope = dict(hass=mgr.hass,ServiceCall=object,DOMAIN="thermostat_timeline",_LOGGER=namespace["_LOGGER"],_save_and_broadcast=AsyncMock())
        exec(compile(ast.Module(body=[patch_function],type_ignores=[]),str(source),"exec"),scope)
        for mode in ("off",None):
            await scope["patch_entity"](SimpleNamespace(data={"entity_id":"climate.room","data":{"defaultMode":mode}}))
            self.assertEqual(mgr.hass.data["thermostat_timeline"]["schedules"]["climate.room"]["defaultMode"],mode)

    async def test_effective_weekday_prefers_copied_mode_and_keeps_legacy_fallback(self):
        mgr = self.make({"weekdays_enabled":True})
        mgr._today_key = lambda:"sun"
        settings = mgr.hass.data["thermostat_timeline"]["settings"]
        row = {"defaultTemp":18.5,"defaultMode":"heat","blocks":[],
            "weekly":{"mode":"all_7","days":{"sun":[{"startMin":60,"endMin":120,"temp":21}]}},
            "weekly_modes":{"all_7":{"days":{"sun":[{"startMin":60,"endMin":120,"hvacMode":"off"}]}}}}
        schedules = {"climate.room":row}
        self.assertEqual(mgr._desired_action_for("climate.room",schedules,settings,90),{"hvacMode":"off","temperature":None})
        row["weekly_modes"]["all_7"]["days"]["sun"] = []
        self.assertEqual(mgr._desired_action_for("climate.room",schedules,settings,90),{"hvacMode":"heat","temperature":18.5})
        del row["weekly_modes"]["all_7"]["days"]["sun"]
        self.assertEqual(mgr._desired_action_for("climate.room",schedules,settings,90),{"hvacMode":None,"temperature":21})


class ManualOverrideTests(unittest.IsolatedAsyncioTestCase):
    make = AutoApplyTests.make

    async def test_store_refresh_preserves_manual_override_until_desired_temperature_changes(self):
        mgr = self.make({'auto_apply_enabled': True, 'apply_on_edit': True}, state='heat')
        entity = mgr.hass.states.get('climate.room')
        entity.attributes['temperature'] = 21
        mgr._now_min = lambda: 14 * 60
        desired = {'value': 21}
        mgr._desired_for = lambda *args: desired['value']
        await mgr._maybe_apply_now(force=True)
        self.call.assert_not_awaited()
        self.assertEqual(mgr._last_applied['climate.room']['temp'], 21)
        entity.attributes['temperature'] = 22.5
        mgr._maybe_control_boiler = AsyncMock()
        mgr._schedule_next = AsyncMock()
        for method in ('_reset_person_watch','_reset_boiler_watch','_reset_boiler_interval','_reset_pause_sensor_watch','_reset_target_recovery_watch'):
            setattr(mgr, method, lambda: None)
        await mgr._on_store_changed()
        self.call.assert_not_awaited()
        desired['value'] = 20
        await mgr._on_store_changed()
        self.call.assert_awaited()
        self.assertEqual(self.call.await_args.args[2]['temperature'], 20)

    async def test_normal_application_does_not_log_warning(self):
        mgr = self.make({}, state='heat')
        with self.assertNoLogs(namespace['_LOGGER'], level='WARNING'):
            self.assertTrue(await mgr._apply_setpoint('climate.room', 20))

if __name__ == '__main__':
    unittest.main()
