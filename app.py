import sys
import os
import numpy as np

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QListWidget, QFileDialog, QSplitter, QLabel, QSlider,
    QStatusBar
)
from PyQt6.QtCore import Qt, pyqtSignal
from functools import partial

# Matplotlib를 PyQt6에 통합하기 위한 위젯들
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure

class MplCanvas(FigureCanvas):
    mouseDragged = pyqtSignal(int, int)
    wheelScrolled = pyqtSignal(int)

    def __init__(self, parent=None, width=6, height=4, dpi=100):
        fig = Figure(figsize=(width, height), dpi=dpi, facecolor='black')
        fig.subplots_adjust(left=0, right=1, bottom=0, top=1)
        self.axes = fig.add_subplot(111)
        self.axes.axis('off')
        super(MplCanvas, self).__init__(fig)
        self._is_right_mouse_pressed = False
        self._last_mouse_pos = None

    def update_figure(self, image_data):
        if image_data is not None:
            self.axes.clear()
            self.axes.imshow(image_data, cmap='gray')
            self.axes.axis('off')
            self.draw()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.RightButton:
            self._is_right_mouse_pressed = True
            self._last_mouse_pos = event.pos()
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.RightButton:
            self._is_right_mouse_pressed = False
            self._last_mouse_pos = None
        super().mouseReleaseEvent(event)

    def mouseMoveEvent(self, event):
        if self._is_right_mouse_pressed and self._last_mouse_pos:
            delta = event.pos() - self._last_mouse_pos
            self.mouseDragged.emit(delta.x(), delta.y())
            self._last_mouse_pos = event.pos()
        super().mouseMoveEvent(event)

    def wheelEvent(self, event):
        delta = event.angleDelta().y()
        self.wheelScrolled.emit(delta)
        event.accept()

class NpyViewer(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("DCMViewer")
        self.setGeometry(100, 100, 1200, 800)
        self.file_paths = {}
        self.image_data_3d = None
        self.current_slice_index = 0
        self.window_level = 40
        self.window_width = 400
        self.init_ui()
        
    def _create_slider_group(self, label_text):
        layout = QHBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)
        
        label = QLabel(label_text)
        
        slider = QSlider(Qt.Orientation.Horizontal)
        
        dec_button = QPushButton("-")
        dec_button.setFixedWidth(24)
        
        value_label = QLabel("0")
        value_label.setFixedWidth(32)
        value_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        
        inc_button = QPushButton("+")
        inc_button.setFixedWidth(24)
        
        layout.addWidget(label)
        layout.addWidget(slider)
        layout.addWidget(dec_button)
        layout.addWidget(value_label)
        layout.addWidget(inc_button)
        
        return {
            "layout": layout,
            "slider": slider,
            "value_label": value_label,
            "inc_button": inc_button,
            "dec_button": dec_button
        }

    def init_ui(self):
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QHBoxLayout(central_widget)
        main_layout.setContentsMargins(6, 6, 6, 6)
        main_layout.setSpacing(8)

        # 상태 표시줄 (푸터) 생성
        status_bar = QStatusBar()
        self.setStatusBar(status_bar)
        self.status_total_files = QLabel("Total Files: 0")
        self.status_current_file = QLabel("Current File: None")
        self.status_current_version = QLabel("v1.1")
        self.status_current_version.setStyleSheet("color: gray;")
        status_bar.addWidget(self.status_total_files)
        status_bar.addWidget(self.status_current_file)
        status_bar.addPermanentWidget(self.status_current_version)
        
        splitter = QSplitter(Qt.Orientation.Horizontal)
        main_layout.addWidget(splitter)

        left_panel = QWidget()
        left_layout = QVBoxLayout(left_panel)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(8)
        
        left_panel_width = 300
        left_panel.setMinimumWidth(left_panel_width)
        left_panel.setMaximumWidth(left_panel_width)
        self.file_list_widget = QListWidget()
        self.file_list_widget.setStyleSheet("border: 1px solid gray; border-radius: 4px; padding: 1px;")
        
        self.load_button = QPushButton("Load Data")
        self.load_button.setStyleSheet("border: 1px solid gray; border-radius: 4px; padding: 4px; padding-top: 8px; padding-bottom: 8px;")
        left_layout.addWidget(self.file_list_widget)
        left_layout.addWidget(self.load_button)

        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(8)
        
        canvas_container = QWidget()
        canvas_layout = QVBoxLayout(canvas_container)
        canvas_container.setStyleSheet("border: 1px solid gray; border-radius: 4px; padding: 1px; background-color: black;")
        
        self.canvas = MplCanvas(self)
        self.canvas.setStyleSheet("border: 1px solid gray; border-radius: 4px; padding: 1px; background-color: black;")
        canvas_layout.addWidget(self.canvas, 1)

        right_layout.addWidget(canvas_container, 1)
        
        self.slice_widgets = self._create_slider_group("Slice:")
        self.ww_widgets = self._create_slider_group("Window Width (WW):")
        self.wl_widgets = self._create_slider_group("Window Level (WL):")

        ww_wl_layout = QHBoxLayout()
        ww_wl_layout.setSpacing(6)
        ww_wl_layout.addLayout(self.ww_widgets["layout"])
        ww_wl_layout.addLayout(self.wl_widgets["layout"])
        
        right_layout.addLayout(self.slice_widgets["layout"])
        right_layout.addLayout(ww_wl_layout)
        
        splitter.addWidget(left_panel)
        splitter.addWidget(right_panel)
        splitter.setSizes([100, 600])

        self.load_button.clicked.connect(self.load_data)
        self.file_list_widget.currentItemChanged.connect(self.on_file_selected)
        self.canvas.wheelScrolled.connect(self.update_slice)
        self.canvas.mouseDragged.connect(self.update_windowing)

        self.slice_widgets["slider"].valueChanged.connect(self.set_slice_from_slider)
        self.ww_widgets["slider"].valueChanged.connect(self.set_ww_from_slider)
        self.wl_widgets["slider"].valueChanged.connect(self.set_wl_from_slider)
        
        self.slice_widgets["inc_button"].clicked.connect(partial(self._adjust_slider, self.slice_widgets["slider"], 1))
        self.slice_widgets["dec_button"].clicked.connect(partial(self._adjust_slider, self.slice_widgets["slider"], -1))
        self.ww_widgets["inc_button"].clicked.connect(partial(self._adjust_slider, self.ww_widgets["slider"], 1))
        self.ww_widgets["dec_button"].clicked.connect(partial(self._adjust_slider, self.ww_widgets["slider"], -1))
        self.wl_widgets["inc_button"].clicked.connect(partial(self._adjust_slider, self.wl_widgets["slider"], 1))
        self.wl_widgets["dec_button"].clicked.connect(partial(self._adjust_slider, self.wl_widgets["slider"], -1))

    def _adjust_slider(self, slider, amount):
        slider.setValue(slider.value() + amount)

    def set_slice_from_slider(self, value):
        if self.image_data_3d is not None and value != self.current_slice_index:
            self.current_slice_index = value
            self.redraw_image()

    def set_ww_from_slider(self, value):
        if self.image_data_3d is not None and value != self.window_width:
            self.window_width = value
            self.redraw_image()

    def set_wl_from_slider(self, value):
        if self.image_data_3d is not None and value != self.window_level:
            self.window_level = value
            self.redraw_image()

    def apply_windowing(self, slice_2d, level, width):
        min_val = level - (width / 2)
        max_val = level + (width / 2)
        clipped = np.clip(slice_2d, min_val, max_val)
        if max_val - min_val > 0:
            normalized = ((clipped - min_val) / (max_val - min_val)) * 255.0
        else:
            normalized = np.zeros_like(clipped)
        return normalized.astype(np.uint8)

    def redraw_image(self):
        if self.image_data_3d is None: return
        
        current_slice = self.image_data_3d[self.current_slice_index]
        display_image = self.apply_windowing(current_slice, self.window_level, self.window_width)
        self.canvas.update_figure(display_image)
        
        for widgets, value in [
            (self.slice_widgets, self.current_slice_index),
            (self.ww_widgets, int(self.window_width)),
            (self.wl_widgets, int(self.window_level))
        ]:
            widgets["slider"].blockSignals(True)
            widgets["slider"].setValue(value)
            widgets["slider"].blockSignals(False)
            widgets["value_label"].setText(str(value))

    def update_slice(self, delta):
        if self.image_data_3d is not None:
            amount = 1 if delta > 0 else -1
            self.slice_widgets["slider"].setValue(self.slice_widgets["slider"].value() + amount)

    def update_windowing(self, dx, dy):
        sensitivity = 1.0
        self.wl_widgets["slider"].setValue(int(self.wl_widgets["slider"].value() + dx * sensitivity))
        self.ww_widgets["slider"].setValue(int(self.ww_widgets["slider"].value() - dy * sensitivity))

    def load_data(self):
        filepaths, _ = QFileDialog.getOpenFileNames(self, "NPY 파일을 선택하세요", "", "NPY Files (*.npy)")
        if filepaths:
            for path in filepaths:
                base_filename = os.path.splitext(os.path.basename(path))[0]
                if base_filename not in self.file_paths:
                    self.file_paths[base_filename] = path
                    self.file_list_widget.addItem(base_filename)
            self.status_total_files.setText(f"Total Files: {self.file_list_widget.count()}")

    def on_file_selected(self, current_item, _):
        if not current_item:
            self.status_current_file.setText("Current File: None")
            return
            
        filename = current_item.text()
        filepath = self.file_paths.get(filename)
        if filepath:
            try:
                data = np.load(filepath)
                if data.ndim == 3 and data.shape[1] == 512 and data.shape[2] == 512:
                    self.image_data_3d = data
                    
                    num_slices = data.shape[0]
                    data_min, data_max = int(np.min(data)), int(np.max(data))
                    data_range = data_max - data_min or 1
                    
                    self.slice_widgets["slider"].setRange(0, num_slices - 1)
                    self.wl_widgets["slider"].setRange(data_min, data_max)
                    self.ww_widgets["slider"].setRange(1, data_range)
                    
                    self.window_level = (data_max + data_min) / 2
                    self.window_width = data_range
                    self.current_slice_index = num_slices // 2
                    
                    self.redraw_image()
                    self.status_current_file.setText(f"Current File: {filename}")
                    self.statusBar().showMessage(f"'{filename}' loaded successfully. Shape: {data.shape}", 3000)
                else:
                    self.statusBar().showMessage("Error: Data shape is not (slice, 512, 512).", 3000)
            except Exception as e:
                self.statusBar().showMessage(f"Error loading file: {e}", 3000)

if __name__ == '__main__':
    app = QApplication(sys.argv)
    viewer = NpyViewer()
    viewer.show()
    sys.exit(app.exec())