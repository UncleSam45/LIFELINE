import subprocess
from pathlib import Path
from unittest import mock

import main


def test_support_services_launch_ollama_before_memory_manager():
    with mock.patch.object(main, "_launch_ollama") as ollama, mock.patch.object(
        main, "_launch_memory_manager"
    ) as memory:
        manager = mock.Mock()
        manager.attach_mock(ollama, "ollama")
        manager.attach_mock(memory, "memory")

        main._launch_support_services()

        assert manager.mock_calls == [mock.call.ollama(), mock.call.memory()]


def test_launch_ollama_uses_serve_for_cli_binary():
    with mock.patch.object(main, "_ollama_is_running", return_value=False), mock.patch.object(
        main, "_ollama_executable", return_value=Path("/opt/bin/ollama")
    ), mock.patch.object(main, "_spawn_background", return_value=mock.sentinel.process) as spawn, mock.patch.object(
        main, "_verify_background_start"
    ) as verify:
        main._launch_ollama()

    spawn.assert_called_once_with(["/opt/bin/ollama", "serve"], "ollama.log")
    verify.assert_called_once_with(mock.sentinel.process, "Ollama", "ollama.log")


def test_launch_memory_manager_uses_current_python():
    with mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(
        main, "_spawn_background", return_value=mock.sentinel.process
    ) as spawn, mock.patch.object(main, "_verify_background_start") as verify:
        main._launch_memory_manager()

    spawn.assert_called_once_with(
        [main.sys.executable, str(main.MEMORY_MANAGER_PATH)], "memory-manager.log"
    )
    verify.assert_called_once_with(
        mock.sentinel.process, "LIFELINE Memory Manager", "memory-manager.log"
    )


def test_support_services_attempts_memory_manager_when_ollama_fails(capsys):
    with mock.patch.object(main, "_launch_ollama", side_effect=OSError("broken")), mock.patch.object(
        main, "_launch_memory_manager"
    ) as memory:
        main._launch_support_services()

    memory.assert_called_once_with()
    assert "Could not launch Ollama: broken" in capsys.readouterr().err


def test_verify_background_start_reports_early_exit(tmp_path):
    process = mock.Mock()
    process.wait.return_value = 7
    with mock.patch.object(main, "RUNTIME_DIR", tmp_path):
        (tmp_path / "service.log").write_text("startup failed\n", encoding="utf-8")
        try:
            main._verify_background_start(process, "Service", "service.log")
        except RuntimeError as error:
            assert "code 7" in str(error)
            assert "startup failed" in str(error)
        else:
            raise AssertionError("early service exit was not reported")


def test_verify_background_start_accepts_running_process():
    process = mock.Mock()
    process.wait.side_effect = subprocess.TimeoutExpired(["service"], 1.0)

    main._verify_background_start(process, "Service", "service.log")


def test_spawn_background_closes_parent_log_stream():
    log = mock.Mock()
    with mock.patch.object(main, "_background_process_options", return_value=({}, log)), mock.patch.object(
        subprocess, "Popen", return_value=mock.sentinel.process
    ) as popen:
        result = main._spawn_background(["service"], "service.log")

    assert result is mock.sentinel.process
    popen.assert_called_once_with(["service"])
    log.close.assert_called_once_with()


def test_run_electron_identifies_launcher_process():
    electron = Path("/opt/electron")
    with mock.patch.object(subprocess, "check_call") as check_call, mock.patch.object(
        main.os, "getpid", return_value=4321
    ), mock.patch.dict(main.os.environ, {"EXISTING_SETTING": "kept"}, clear=True):
        main._run_electron(electron)

    check_call.assert_called_once()
    command = check_call.call_args.args[0]
    options = check_call.call_args.kwargs
    assert command == [str(electron), str(main.ELECTRON_MAIN_PATH)]
    assert options["cwd"] == main.APP_ROOT
    assert options["env"]["LIFELINE_LAUNCHER_PID"] == "4321"
    assert options["env"]["EXISTING_SETTING"] == "kept"
