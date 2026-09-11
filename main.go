package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	// Menu events are forwarded to the frontend as "menu:<action>" events.
	emit := func(action string) func(*menu.CallbackData) {
		return func(*menu.CallbackData) { runtime.EventsEmit(app.ctx, "menu:"+action) }
	}
	appMenu := menu.NewMenu()
	appMenu.Append(menu.AppMenu())
	file := appMenu.AddSubmenu("File")
	file.AddText("New Query Tab", keys.CmdOrCtrl("t"), emit("newtab"))
	file.AddText("Close Tab", keys.CmdOrCtrl("w"), emit("closetab"))
	file.AddSeparator()
	file.AddText("New Connection...", keys.Combo("n", keys.CmdOrCtrlKey, keys.ShiftKey), emit("newconnection"))
	appMenu.Append(menu.EditMenu())
	query := appMenu.AddSubmenu("Query")
	query.AddText("Run", keys.CmdOrCtrl("return"), emit("run"))
	query.AddText("Cancel", keys.Combo("escape", keys.CmdOrCtrlKey, keys.ShiftKey), emit("cancel"))
	query.AddSeparator()
	query.AddText("Explain", keys.CmdOrCtrl("e"), emit("explain"))
	query.AddText("Explain Analyze", keys.Combo("e", keys.CmdOrCtrlKey, keys.ShiftKey), emit("explainanalyze"))
	query.AddSeparator()
	query.AddText("Export Results as CSV...", keys.Combo("s", keys.CmdOrCtrlKey, keys.ShiftKey), emit("export"))
	tools := appMenu.AddSubmenu("Tools")
	tools.AddText("Query Statistics", keys.Combo("p", keys.CmdOrCtrlKey, keys.ShiftKey), emit("stats"))
	appMenu.Append(menu.WindowMenu())

	err := wails.Run(&options.App{
		Title:     "pginspect",
		Width:     1280,
		Height:    820,
		MinWidth:  800,
		MinHeight: 500,
		Menu:      appMenu,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 30, G: 30, B: 32, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind: []interface{}{
			app,
		},
		Mac: &mac.Options{
			TitleBar:             mac.TitleBarDefault(),
			Appearance:           mac.DefaultAppearance,
			WebviewIsTransparent: false,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
