import sys
import os
import platform
import pydicom
import numpy as np
from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure
from PyQt5.QtCore import Qt
from collections import defaultdict
import matplotlib.pyplot as plt
from PyQt5.QtGui import QIcon
from PyQt5.QtWidgets import (QApplication, QMainWindow, QVBoxLayout, QHBoxLayout, 
                            QWidget, QPushButton, QFileDialog, QTreeWidget, 
                            QTreeWidgetItem, QSlider, QLineEdit, QLabel, QSplitter,
                            QProgressDialog, QProgressBar, QListWidget, QDialog, 
                            QDialogButtonBox, QMessageBox, QSpinBox)
from PyQt5.QtCore import QThread, pyqtSignal
import subprocess

HU_RANGE_MIN = -1024
HU_RANGE_MAX = 3071

class DicomDatabase:
    """DICOM 파일들을 환자/스터디/시리즈 계층 구조로 관리하는 데이터베이스 클래스"""
    
    def __init__(self):
        """데이터베이스 초기화 - 중첩된 딕셔너리 구조로 환자/스터디/시리즈 정보 저장"""
        self.data = defaultdict(lambda: defaultdict(lambda: defaultdict(dict)))
        self.series_files = defaultdict(list)
    
    def add_file(self, file_path):
        """DICOM 파일을 읽어서 데이터베이스에 추가하는 메서드"""
        try:
            ds = pydicom.dcmread(file_path, force=True)
            patient_id = getattr(ds, 'PatientID', 'Unknown')
            study_uid = getattr(ds, 'StudyInstanceUID', 'Unknown')
            series_uid = getattr(ds, 'SeriesInstanceUID', 'Unknown')
            
            # 메타데이터 저장
            if not self.data[patient_id][study_uid][series_uid]:
                self.data[patient_id][study_uid][series_uid] = {
                    'PatientName': getattr(ds, 'PatientName', 'Unknown'),
                    'StudyDescription': getattr(ds, 'StudyDescription', 'Unknown'),
                    'SeriesDescription': getattr(ds, 'SeriesDescription', 'Unknown'),
                    'Modality': getattr(ds, 'Modality', 'Unknown'),
                    'SliceThickness': getattr(ds, 'SliceThickness', 'Unknown')
                }
            
            # 파일 경로 저장
            self.series_files[series_uid].append(file_path)
            
        except Exception as e:
            print(f"Error reading {file_path}: {e}")


class MultiFolderDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Manage Data")
        self.setMinimumSize(600, 500)
        self.selected_folders = []
        self.parent_viewer = parent
        
        layout = QVBoxLayout(self)
        layout.setSpacing(8)
        layout.setContentsMargins(6, 6, 6, 6)
        
        # 설명 라벨
        info_label = QLabel("List of data loading paths")
        layout.addWidget(info_label)
        
        # 폴더 리스트
        self.folder_list = QListWidget()
        layout.addWidget(self.folder_list)
        
        # 기존 저장된 경로들 로드
        if self.parent_viewer:
            saved_paths = self.parent_viewer.load_data_paths()
            for path in saved_paths:
                self.selected_folders.append(path)
                item_text = f"[Saved] {path}"
                self.folder_list.addItem(item_text)
        
        # 버튼들
        button_layout = QHBoxLayout()
        button_layout.setSpacing(4)
        button_layout.setContentsMargins(0, 0, 0, 0)
        
        add_button = QPushButton("Add Folder(Directory)")
        add_button.clicked.connect(self.add_folder)
        button_layout.addWidget(add_button)

        remove_button = QPushButton("Remove Folder(Directory)")
        remove_button.clicked.connect(self.remove_folder)
        button_layout.addWidget(remove_button)
        
        layout.addLayout(button_layout)
        
        # 다이얼로그 버튼
        button_box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        button_box.accepted.connect(self.accept)
        button_box.rejected.connect(self.reject)
        layout.addWidget(button_box)
    
    def add_folder(self):
        folder_path = QFileDialog.getExistingDirectory(self, "Select Folder(Directory)", "", QFileDialog.ShowDirsOnly | QFileDialog.DontResolveSymlinks)
        if folder_path and folder_path not in self.selected_folders:
            self.selected_folders.append(folder_path)
            item_text = f"[New] {folder_path}"
            self.folder_list.addItem(item_text)
    
    def remove_folder(self):
        current_row = self.folder_list.currentRow()
        if current_row >= 0:
            removed_path = self.selected_folders[current_row]
            self.folder_list.takeItem(current_row)
            del self.selected_folders[current_row]
            
            # 제거된 경로가 저장된 경로였다면 dataPath.txt에서도 제거
            if self.parent_viewer:
                saved_paths = self.parent_viewer.load_data_paths()
                if removed_path in saved_paths:
                    saved_paths.remove(removed_path)
                    self.parent_viewer.save_data_paths(saved_paths)
    
    def get_selected_folders(self):
        return self.selected_folders


class DicomLoadWorker(QThread):
    """백그라운드에서 DICOM 파일을 로드하는 워커 스레드 클래스"""
    
    # 진행률과 완료 상태를 메인 스레드에 알리는 시그널들
    progress = pyqtSignal(int)
    finished = pyqtSignal()
    file_processed = pyqtSignal(str)
    
    def __init__(self, folder_paths, database):
        """워커 스레드 초기화"""
        super().__init__()
        self.folder_paths = folder_paths if isinstance(folder_paths, list) else [folder_paths]
        self.database = database
        self.dcm_files = []
    
    def run(self):
        """스레드 실행 메서드 - 폴더들에서 DICOM 파일들을 찾아서 데이터베이스에 추가"""
        # 모든 선택된 폴더에서 DCM 파일 찾기
        for folder_path in self.folder_paths:
            for root, dirs, files in os.walk(folder_path):
                for file in files:
                    if file.lower().endswith('.dcm') and not file.startswith('.'):
                        file_path = os.path.join(root, file)
                        self.dcm_files.append(file_path)
        
        total_files = len(self.dcm_files)
        if total_files == 0:
            self.finished.emit()
            return
        
        # 파일 처리
        for i, file_path in enumerate(self.dcm_files):
            self.database.add_file(file_path)
            # 파일 경로가 32글자를 넘으면 앞쪽을 ...으로 처리
            display_path = file_path if len(file_path) <= 32 else "..." + file_path[-29:]
            self.file_processed.emit(display_path)
            progress_percent = int((i + 1) / total_files * 100)
            self.progress.emit(progress_percent)
        
        self.finished.emit()


class DicomViewer(QMainWindow):
    """DICOM CT 이미지를 보여주는 메인 뷰어 클래스"""
    
    def __init__(self):
        """뷰어 초기화 - 데이터베이스와 디스플레이 설정 초기화"""
        super().__init__()
        self.database = DicomDatabase()
        self.current_volume = None
        self.current_slice = 0
        self.window_level = 40  # 일반적인 CT Window Level
        self.window_width = 400  # 일반적인 CT Window Width
        
        # DICOM 변환 파라미터
        self.rescale_slope = 1.0
        self.rescale_intercept = -1024.0
        
        # HU Min/Max 변수 (실제 HU 값)
        self.hu_min = self.window_level - self.window_width // 2  # -160
        self.hu_max = self.window_level + self.window_width // 2  # 240
        
        # 마우스 드래그 관련 변수
        self.dragging = False
        self.drag_start_x = 0
        self.drag_start_y = 0
        self.initial_window_level = 0
        self.initial_window_width = 0
        
        # 경로 저장 파일
        self.data_path_file = "dataPath.txt"
        
        self.init_ui()
        
        # 프로그램 시작 시 저장된 경로 자동 로드
        self.auto_load_saved_paths()
    
    def init_ui(self):
        """사용자 인터페이스 초기화 - 레이아웃과 위젯들 설정"""
        self.setWindowTitle("DICOM CT Viewer")
        self.setGeometry(100, 100, 1200, 960)
        
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        # 메인 레이아웃 - 세로 (2행)
        main_layout = QVBoxLayout(central_widget)
        main_layout.setSpacing(2)
        main_layout.setContentsMargins(6, 6, 6, 6)
        
        # 첫 번째 행 - 버튼들
        button_layout = QHBoxLayout()
        button_layout.setSpacing(4)
        button_layout.setContentsMargins(0, 0, 0, 0)
        
        # 폴더 로드 버튼
        self.load_button = QPushButton("Manage Data")
        self.load_button.setIcon(QIcon.fromTheme("folder-open"))
        self.load_button.setToolTip("Manage Data Load Folders")
        self.load_button.clicked.connect(self.load_folder)
        button_layout.addWidget(self.load_button)
        
        # 이미지 저장 버튼
        self.save_button = QPushButton("Save Image")
        self.save_button.setIcon(QIcon.fromTheme("document-save"))
        self.save_button.setToolTip("Save Current Slice with Window Level/Width as PNG")
        self.save_button.clicked.connect(self.save_image)
        button_layout.addWidget(self.save_button)
        
        # 버튼을 왼쪽으로 정렬하기 위한 스트레치 추가
        button_layout.addStretch()
        
        main_layout.addLayout(button_layout)
        
        # 두 번째 행 - 메인 콘텐츠 (2열)
        content_splitter = QSplitter(Qt.Horizontal)
        
        # 왼쪽 열 - DICOM 데이터베이스 트리
        left_panel = QWidget()
        left_layout = QVBoxLayout(left_panel)
        left_layout.setSpacing(2)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_panel.setMinimumWidth(250)
        
        # 데이터베이스 트리
        database_label = QLabel("DICOM Database")
        database_label.setStyleSheet("font-weight: bold; padding: 0px 0px 6px 0px;")
        left_layout.addWidget(database_label)
        self.tree_widget = QTreeWidget()
        self.tree_widget.setHeaderLabel("Data Viewer")
        self.tree_widget.itemClicked.connect(self.on_series_selected)
        left_layout.addWidget(self.tree_widget)
        
        # Footer with statistics
        self.stats_label = QLabel("Patients: 0 | Studies: 0 | Series: 0")
        self.stats_label.setStyleSheet("color: gray; font-size: 10px; padding: 2px;")
        left_layout.addWidget(self.stats_label)
        
        content_splitter.addWidget(left_panel)
        
        # 오른쪽 열 - 이미지 디스플레이와 컨트롤
        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        right_layout.setSpacing(2)
        right_layout.setContentsMargins(2, 2, 2, 2)
        
        # 이미지 디스플레이
        self.figure = Figure(figsize=(8, 8), facecolor='black')
        self.canvas = FigureCanvas(self.figure)
        self.canvas.setStyleSheet("background-color: black;")
        
        # 마우스 이벤트 연결
        self.canvas.mpl_connect('scroll_event', self.on_scroll)
        self.canvas.mpl_connect('button_press_event', self.on_mouse_press)
        self.canvas.mpl_connect('button_release_event', self.on_mouse_release)
        self.canvas.mpl_connect('motion_notify_event', self.on_mouse_motion)
        
        right_layout.addWidget(self.canvas, 1)  # stretch factor 1을 추가하여 최대 높이 차지
        
        # 컨트롤 패널
        controls_layout = QVBoxLayout()
        controls_layout.setSpacing(8)
        controls_layout.setContentsMargins(0, 10, 0, 0)
        
        # 슬라이스 컨트롤
        slice_layout = QHBoxLayout()
        slice_layout.setSpacing(5)
        slice_layout.addWidget(QLabel("Slice:"))
        self.slice_slider = QSlider(Qt.Horizontal)
        self.slice_slider.valueChanged.connect(self.update_slice)
        slice_layout.addWidget(self.slice_slider)
        self.slice_input = QSpinBox()
        self.slice_input.setMaximumWidth(80)
        self.slice_input.setMinimum(0)
        self.slice_input.setMaximum(0)
        self.slice_input.setValue(0)
        self.slice_input.editingFinished.connect(self.update_slice_from_spinbox)
        slice_layout.addWidget(self.slice_input)
        controls_layout.addLayout(slice_layout)
        
        slider_control_layout = QHBoxLayout()
        
        # 윈도우 컨트롤 그룹
        window_group_layout = QVBoxLayout()
        window_group_layout.setSpacing(2)
        
        # 그룹 제목
        window_group_label = QLabel("Window Level/Width Controls")
        window_group_label.setStyleSheet("font-weight: bold; padding: 0px 0px 6px 0px;")
        window_group_layout.addWidget(window_group_label)
        
        # 윈도우 레벨 컨트롤
        wl_layout = QHBoxLayout()
        wl_layout.setSpacing(5)
        wl_layout.setContentsMargins(0, 8, 0, 8)
        wl_layout.addWidget(QLabel("Window Level:"))
        self.wl_slider = QSlider(Qt.Horizontal)
        self.wl_slider.setRange(-3000, 4000)  # 더 넓은 HU 값 범위
        self.wl_slider.setValue(self.window_level)
        self.wl_slider.valueChanged.connect(self.update_window_level)
        wl_layout.addWidget(self.wl_slider)
        self.wl_input = QSpinBox()
        self.wl_input.setMaximumWidth(100)
        self.wl_input.setMinimum(HU_RANGE_MIN)  # 더 넓은 HU 값 범위
        self.wl_input.setMaximum(HU_RANGE_MAX)
        self.wl_input.setValue(self.window_level)
        self.wl_input.editingFinished.connect(self.update_wl_from_spinbox)
        wl_layout.addWidget(self.wl_input)
        window_group_layout.addLayout(wl_layout)
        
        # 윈도우 폭 컨트롤
        ww_layout = QHBoxLayout()
        ww_layout.setSpacing(2)
        ww_layout.setContentsMargins(0, 8, 0, 8)
        ww_layout.addWidget(QLabel("Window Width:"))
        self.ww_slider = QSlider(Qt.Horizontal)
        self.ww_slider.setRange(1, 4096)
        self.ww_slider.setValue(self.window_width)
        self.ww_slider.valueChanged.connect(self.update_window_width)
        ww_layout.addWidget(self.ww_slider)
        self.ww_input = QSpinBox()
        self.ww_input.setMaximumWidth(100)
        self.ww_input.setMinimum(1)
        self.ww_input.setMaximum(4096)
        self.ww_input.setValue(self.window_width)
        self.ww_input.editingFinished.connect(self.update_ww_from_spinbox)
        ww_layout.addWidget(self.ww_input)
        window_group_layout.addLayout(ww_layout)
        
        slider_control_layout.addLayout(window_group_layout)
        
        # HU Min/Max 컨트롤 그룹
        hu_group_layout = QVBoxLayout()
        hu_group_layout.setSpacing(5)
        
        hu_group_header_layout = QHBoxLayout()
        hu_group_header_layout.setContentsMargins(0, 0, 0, 0)
        
        # 그룹 제목
        hu_group_label = QLabel("HU Min/Max Controls")
        hu_group_label.setStyleSheet("font-weight: bold; padding: 0px 0px 6px 0px;")
        hu_group_layout.addWidget(hu_group_label)
        
        # HU Min 컨트롤
        hmin_layout = QHBoxLayout()
        hmin_layout.setSpacing(5)
        hmin_layout.setContentsMargins(0, 8, 0, 8)
        hmin_layout.addWidget(QLabel("HU Min:"))
        self.hmin_slider = QSlider(Qt.Horizontal)
        self.hmin_slider.setRange(HU_RANGE_MIN, HU_RANGE_MAX)  # 더 넓은 HU 값 범위
        self.hmin_slider.setValue(self.hu_min)
        self.hmin_slider.valueChanged.connect(self.update_hu_min)
        hmin_layout.addWidget(self.hmin_slider)
        self.hmin_input = QSpinBox()
        self.hmin_input.setMaximumWidth(100)
        self.hmin_input.setMinimum(HU_RANGE_MIN)  # 더 넓은 HU 값 범위
        self.hmin_input.setMaximum(HU_RANGE_MAX)
        self.hmin_input.setValue(self.hu_min)
        self.hmin_input.editingFinished.connect(self.update_hmin_from_spinbox)
        hmin_layout.addWidget(self.hmin_input)
        hu_group_layout.addLayout(hmin_layout)
        
        # HU Max 컨트롤
        hmax_layout = QHBoxLayout()
        hmax_layout.setSpacing(5)
        hmax_layout.setContentsMargins(0, 8, 0, 8)
        hmax_layout.addWidget(QLabel("HU Max:"))
        self.hmax_slider = QSlider(Qt.Horizontal)
        self.hmax_slider.setRange(HU_RANGE_MIN, HU_RANGE_MAX)  # 더 넓은 HU 값 범위
        self.hmax_slider.setValue(self.hu_max)
        self.hmax_slider.valueChanged.connect(self.update_hu_max)
        hmax_layout.addWidget(self.hmax_slider)
        self.hmax_input = QSpinBox()
        self.hmax_input.setMaximumWidth(100)
        self.hmax_input.setMinimum(HU_RANGE_MIN)  # 더 넓은 HU 값 범위
        self.hmax_input.setMaximum(HU_RANGE_MAX)
        self.hmax_input.setValue(self.hu_max)
        self.hmax_input.editingFinished.connect(self.update_hmax_from_spinbox)
        hmax_layout.addWidget(self.hmax_input)
        hu_group_layout.addLayout(hmax_layout)

        slider_control_layout.addLayout(hu_group_layout)

        controls_layout.addLayout(slider_control_layout)
        right_layout.addLayout(controls_layout)
        content_splitter.addWidget(right_panel)
        
        # 스플리터 비율 설정 및 완전 접힘 방지
        content_splitter.setStretchFactor(0, 1)
        content_splitter.setStretchFactor(1, 2)
        content_splitter.setCollapsible(0, False)
        content_splitter.setCollapsible(1, False)
        content_splitter.setChildrenCollapsible(False)
        main_layout.addWidget(content_splitter)
    
    def save_data_paths(self, folder_paths):
        """선택된 폴더 경로들을 파일에 저장"""
        try:
            with open(self.data_path_file, 'w', encoding='utf-8') as f:
                for path in folder_paths:
                    f.write(path + '\n')
            print(f"Paths saved: {len(folder_paths)} folders")
        except Exception as e:
            print(f"Failed to save paths: {e}")
    
    def load_data_paths(self):
        """파일에서 저장된 폴더 경로들을 불러오기"""
        if not os.path.exists(self.data_path_file):
            return []
        
        try:
            with open(self.data_path_file, 'r', encoding='utf-8') as f:
                paths = [line.strip() for line in f.readlines() if line.strip()]
            # 존재하는 경로만 반환
            existing_paths = [path for path in paths if os.path.exists(path)]
            
            # 존재하지 않는 경로가 있다면 파일 업데이트
            if len(existing_paths) != len(paths):
                self.save_data_paths(existing_paths)
            
            return existing_paths
        except Exception as e:
            print(f"Failed to load paths: {e}")
            return []
    
    def auto_load_saved_paths(self):
        """프로그램 시작 시 저장된 경로 자동 로드"""
        saved_paths = self.load_data_paths()
        if saved_paths:
            print(f"Auto-loading saved paths: {len(saved_paths)} folders")
            self.load_folders_from_paths(saved_paths, is_auto_load=True)
    
    def load_folders_from_paths(self, folder_paths, is_auto_load=False):
        """주어진 경로들에서 DICOM 파일들을 로드"""
        if not folder_paths:
            return
        
        # 데이터베이스 초기화
        self.database = DicomDatabase()
        
        # 프로그레스 다이얼로그 생성
        folder_names = [os.path.basename(folder) for folder in folder_paths]
        if is_auto_load:
            dialog_text = f"Loading DICOM files from {len(folder_paths)} saved folders...\nFolders: {', '.join(folder_names[:3])}"
            title = "Auto Data Loading"
        else:
            dialog_text = f"Loading DICOM files from {len(folder_paths)} selected folders...\nFolders: {', '.join(folder_names[:3])}"
            title = "Load Data"
            
        if len(folder_names) > 3:
            dialog_text += f" 외 {len(folder_names)-3}개"
        
        self.progress_dialog = QProgressDialog(dialog_text, "Cancel", 0, 100, self)
        self.progress_dialog.setWindowTitle(title)
        self.progress_dialog.setMinimumWidth(500)
        self.progress_dialog.setModal(True)
        self.progress_dialog.show()
        
        # 워커 스레드 생성 및 시작
        self.load_worker = DicomLoadWorker(folder_paths, self.database)
        self.load_worker.progress.connect(self.progress_dialog.setValue)
        self.load_worker.file_processed.connect(self.update_progress_text)
        self.load_worker.finished.connect(self.on_loading_finished)
        self.progress_dialog.canceled.connect(self.load_worker.terminate)
        self.load_worker.start()
    
    def load_folder(self):
        """DICOM 파일이 있는 폴더들을 선택하고 로드하는 메서드"""
        # 다중 폴더 선택 다이얼로그 표시
        dialog = MultiFolderDialog(self)
        if dialog.exec_() == QDialog.Accepted:
            selected_folders = dialog.get_selected_folders()
            
            if not selected_folders:
                QMessageBox.information(self, "Information", "No folders selected.")
                # 데이터베이스 초기화
                self.database = DicomDatabase()
                self.current_volume = None
                self.current_slice = 0
                self.tree_widget.clear()
                self.stats_label.setText("Patients: 0 | Studies: 0 | Series: 0")
                self.figure.clear()
                self.canvas.draw()
                return
            
            # 선택된 폴더 경로들을 저장
            self.save_data_paths(selected_folders)
            
            # DICOM 파일 로드
            self.load_folders_from_paths(selected_folders)
    
    def update_progress_text(self, filename):
        """프로그레스 다이얼로그의 텍스트를 업데이트하는 메서드"""
        self.progress_dialog.setLabelText(f"Processing {filename}")
    
    def on_loading_finished(self):
        """파일 로딩이 완료되었을 때 호출되는 메서드"""
        self.progress_dialog.close()
        self.populate_tree()
    
    def save_image(self):
        """현재 표시된 이미지를 파일로 저장하는 메서드"""
        if self.current_volume is None:
            return
        
        file_path, _ = QFileDialog.getSaveFileName(
            self, "Save Image", "", "PNG Files (*.png);;JPEG Files (*.jpg);;All Files (*)")
        
        if file_path:
            self.figure.savefig(file_path, dpi=300, bbox_inches='tight')
    
    def populate_tree(self):
        """데이터베이스 내용을 트리 위젯에 표시하는 메서드"""
        self.tree_widget.clear()
        patient_count = 0
        study_count = 0
        series_count = 0
        for patient_id, studies in self.database.data.items():
            patient_item = QTreeWidgetItem([f"Patient: {patient_id}"])
            self.tree_widget.addTopLevelItem(patient_item)
            patient_count += 1

            for study_uid, series_dict in studies.items():
                study_item = QTreeWidgetItem([f"Study: {study_uid[:8]}..."])
                patient_item.addChild(study_item)
                study_count += 1

                for series_uid, metadata in series_dict.items():
                    series_text = f"Series: {metadata['SeriesDescription']} ({metadata['Modality']})"
                    series_item = QTreeWidgetItem([series_text])
                    series_item.setData(0, Qt.UserRole, series_uid)
                    study_item.addChild(series_item)
                    series_count += 1
        
        self.tree_widget.expandAll()
        self.stats_label.setText(f"Patients: {patient_count} | Studies: {study_count} | Series: {series_count}")

    def on_series_selected(self, item):
        """트리에서 시리즈가 선택되었을 때 호출되는 메서드"""
        series_uid = item.data(0, Qt.UserRole)
        if series_uid:
            self.load_series(series_uid)
    
    def load_series(self, series_uid):
        """선택된 시리즈의 DICOM 파일들을 로드하여 3D 볼륨으로 구성하는 메서드"""
        file_paths = self.database.series_files[series_uid]
        if not file_paths:
            return
        
        # 프로그레스 다이얼로그 생성
        progress_dialog = QProgressDialog(f"Loading series data...", "Cancel", 0, len(file_paths), self)
        progress_dialog.setWindowTitle("Loading Series")
        progress_dialog.setMinimumWidth(400)
        progress_dialog.setModal(True)
        progress_dialog.show()
        
        # DICOM 파일들을 로드하고 슬라이스 위치별로 정렬
        dicom_data = []
        for i, file_path in enumerate(file_paths):
            # 프로그레스 업데이트
            progress_dialog.setValue(i)
            progress_dialog.setLabelText(f"Loading file {i+1} of {len(file_paths)}: {os.path.basename(file_path)}")
            
            # 취소 버튼 체크
            if progress_dialog.wasCanceled():
                progress_dialog.close()
                return
            
            # Qt 이벤트 처리 (UI 응답성 유지)
            QApplication.processEvents()
            
            try:
                ds = pydicom.dcmread(file_path)
                slice_location = getattr(ds, 'SliceLocation', 0)
                dicom_data.append((slice_location, ds))
            except Exception as e:
                print(f"Error loading {file_path}: {e}")
        
        # 프로그레스 다이얼로그 완료 표시
        progress_dialog.setValue(len(file_paths))
        progress_dialog.setLabelText("Sorting slices by location...")
        QApplication.processEvents()
        
        # 슬라이스 위치별로 정렬
        dicom_data.sort(key=lambda x: x[0])
        
        progress_dialog.setLabelText("Creating 3D volume...")
        QApplication.processEvents()
        
        # 3D 볼륨 생성
        if dicom_data:
            first_ds = dicom_data[0][1]
            
            # DICOM 변환 파라미터 읽기
            self.rescale_slope = getattr(first_ds, 'RescaleSlope', 1.0)
            self.rescale_intercept = getattr(first_ds, 'RescaleIntercept', -1024.0)
            
            pixel_array = first_ds.pixel_array
            volume_shape = (len(dicom_data), pixel_array.shape[0], pixel_array.shape[1])
            self.current_volume = np.zeros(volume_shape, dtype=pixel_array.dtype)
            
            for i, (_, ds) in enumerate(dicom_data):
                self.current_volume[i] = ds.pixel_array
            
            # 슬라이스 슬라이더 설정
            self.slice_slider.setRange(0, len(dicom_data) - 1)
            self.slice_slider.setValue(0)
            self.slice_input.setRange(0, len(dicom_data) - 1)
            self.slice_input.setValue(0)
            self.current_slice = 0
            
            self.update_display()
        
        # 프로그레스 다이얼로그 닫기
        progress_dialog.close()
    
    def on_scroll(self, event):
        """마우스 휠 스크롤 이벤트 핸들러 - 슬라이스 변경"""
        if self.current_volume is None:
            return
        
        # 스크롤로 슬라이스 변경
        if event.step > 0:
            # 스크롤 위로: 다음 슬라이스
            new_slice = min(self.current_slice + 1, self.slice_slider.maximum())
        else:
            # 스크롤 아래로: 이전 슬라이스
            new_slice = max(self.current_slice - 1, self.slice_slider.minimum())
        
        if new_slice != self.current_slice:
            self.current_slice = new_slice
            self.slice_slider.setValue(new_slice)
            self.slice_input.setValue(new_slice)
            self.update_display()
    
    def on_mouse_press(self, event):
        """마우스 버튼 누름 이벤트 핸들러"""
        if self.current_volume is None:
            return
            
        # 왼쪽 마우스 버튼 클릭 시 드래그 시작
        if event.button == 1:  # 왼쪽 마우스 버튼
            self.dragging = True
            self.drag_start_x = event.xdata if event.xdata is not None else 0
            self.drag_start_y = event.ydata if event.ydata is not None else 0
            self.initial_window_level = self.window_level
            self.initial_window_width = self.window_width
    
    def on_mouse_release(self, event):
        """마우스 버튼 놓음 이벤트 핸들러"""
        if event.button == 1:  # 왼쪽 마우스 버튼
            self.dragging = False
    
    def on_mouse_motion(self, event):
        """마우스 움직임 이벤트 핸들러 - 윈도우 레벨/너비 조절"""
        if not self.dragging or self.current_volume is None:
            return
            
        if event.xdata is None or event.ydata is None:
            return
        
        # 현재 이미지 크기 가져오기
        current_image = self.current_volume[self.current_slice]
        image_height, image_width = current_image.shape
        
        # 마우스 위치를 0~1 범위로 정규화
        # event.xdata와 event.ydata는 이미지 좌표계 기준
        x_ratio = max(0, min(1, event.xdata / image_width))  # 0(왼쪽) ~ 1(오른쪽)
        y_ratio = max(0, min(1, event.ydata / image_height)) # 0(위쪽) ~ 1(아래쪽)
        
        # 윈도우 레벨 범위 (-3000 ~ 4000)
        level_min = -3000
        level_max = 4000
        # 상하 위치로 윈도우 레벨 조절: 위쪽(0)이 최대값, 아래쪽(1)이 최소값
        new_window_level = int(level_max - y_ratio * (level_max - level_min))
        
        # 윈도우 너비 범위 (1 ~ 4096)
        width_min = 1
        width_max = 4096
        # 좌우 위치로 윈도우 너비 조절: 왼쪽(0)이 최소값, 오른쪽(1)이 최대값
        new_window_width = int(width_min + x_ratio * (width_max - width_min))
        
        # 값이 변경된 경우에만 업데이트
        if new_window_width != self.window_width or new_window_level != self.window_level:
            self.window_width = new_window_width
            self.window_level = new_window_level
            
            # UI 컨트롤 업데이트
            self.ww_slider.blockSignals(True)
            self.ww_input.blockSignals(True)
            self.wl_slider.blockSignals(True)
            self.wl_input.blockSignals(True)
            
            self.ww_slider.setValue(self.window_width)
            self.ww_input.setValue(self.window_width)
            self.wl_slider.setValue(self.window_level)
            self.wl_input.setValue(self.window_level)
            
            self.ww_slider.blockSignals(False)
            self.ww_input.blockSignals(False)
            self.wl_slider.blockSignals(False)
            self.wl_input.blockSignals(False)
            
            # HU Min/Max 업데이트
            self.update_hu_from_window()
            
            # 디스플레이 업데이트
            self.update_display()
    
    def update_slice(self):
        """슬라이스 슬라이더 값이 변경되었을 때 호출되는 메서드"""
        self.current_slice = self.slice_slider.value()
        self.slice_input.blockSignals(True)
        self.slice_input.setValue(self.current_slice)
        self.slice_input.blockSignals(False)
        self.update_display()
    
    def update_slice_from_spinbox(self):
        """슬라이스 스핀박스 값이 변경되었을 때 호출되는 메서드"""
        slice_num = self.slice_input.value()
        if self.current_volume is not None and 0 <= slice_num < self.current_volume.shape[0]:
            self.current_slice = slice_num
            self.slice_slider.blockSignals(True)
            self.slice_slider.setValue(slice_num)
            self.slice_slider.blockSignals(False)
            self.update_display()
    
    def update_slice_from_input(self):
        """슬라이스 입력 필드에서 엔터 키가 눌렸을 때 호출되는 메서드 (호환성 유지)"""
        # SpinBox로 변경되어 더 이상 사용되지 않지만 호환성을 위해 유지
        pass
    
    def update_window_width(self):
        """윈도우 폭 슬라이더 값이 변경되었을 때 호출되는 메서드"""
        self.window_width = self.ww_slider.value()
        self.ww_input.blockSignals(True)
        self.ww_input.setValue(self.window_width)
        self.ww_input.blockSignals(False)
        # HU Min/Max 업데이트
        self.update_hu_from_window()
        self.update_display()
    
    def update_ww_from_spinbox(self):
        """윈도우 폭 스핀박스 값이 변경되었을 때 호출되는 메서드"""
        ww = self.ww_input.value()
        if ww > 0:
            self.window_width = ww
            self.ww_slider.blockSignals(True)
            self.ww_slider.setValue(ww)
            self.ww_slider.blockSignals(False)
            # HU Min/Max 업데이트
            self.update_hu_from_window()
            self.update_display()
    
    def update_ww_from_input(self):
        """윈도우 폭 입력 필드에서 엔터 키가 눌렸을 때 호출되는 메서드"""
        try:
            ww = int(self.ww_input.text())
            if ww > 0:
                self.window_width = ww
                self.ww_slider.setValue(ww)
                # HU Min/Max 업데이트
                self.update_hu_from_window()
                self.update_display()
            else:
                # 0 이하 값이면 원래 값으로 복원
                self.ww_input.setText(str(self.window_width))
        except ValueError:
            # 잘못된 값이면 원래 값으로 복원
            self.ww_input.setText(str(self.window_width))
    
    def update_ww_from_input_realtime(self):
        """윈도우 폭 입력 필드 값이 실시간으로 변경될 때 호출되는 메서드"""
        try:
            text = self.ww_input.text()
            if text:  # 빈 문자열이 아닌 경우
                ww = int(text)
                if ww > 0:
                    self.window_width = ww
                    self.ww_slider.blockSignals(True)
                    self.ww_slider.setValue(ww)
                    self.ww_slider.blockSignals(False)
                    # HU Min/Max 업데이트
                    self.update_hu_from_window()
                    self.update_display()
        except ValueError:
            pass  # 실시간에서는 에러 무시
    
    def update_window_level(self):
        """윈도우 레벨 슬라이더 값이 변경되었을 때 호출되는 메서드"""
        self.window_level = self.wl_slider.value()
        self.wl_input.blockSignals(True)
        self.wl_input.setValue(self.window_level)
        self.wl_input.blockSignals(False)
        # HU Min/Max 업데이트
        self.update_hu_from_window()
        self.update_display()
    
    def update_wl_from_spinbox(self):
        """윈도우 레벨 스핀박스 값이 변경되었을 때 호출되는 메서드"""
        wl = self.wl_input.value()
        self.window_level = wl
        self.wl_slider.blockSignals(True)
        self.wl_slider.setValue(wl)
        self.wl_slider.blockSignals(False)
        # HU Min/Max 업데이트
        self.update_hu_from_window()
        self.update_display()
    
    def update_wl_from_input(self):
        """윈도우 레벨 입력 관련 메서드 (호환성 유지)"""
        pass
    
    def update_wl_from_input_realtime(self):
        """윈도우 레벨 실시간 입력 관련 메서드 (호환성 유지)"""
        pass
    
    def update_ww_from_input(self):
        """윈도우 폭 입력 관련 메서드 (호환성 유지)"""
        pass
    
    def update_ww_from_input_realtime(self):
        """윈도우 폭 실시간 입력 관련 메서드 (호환성 유지)"""
        pass
    
    def update_wl_from_input_realtime(self):
        """윈도우 레벨 입력 필드 값이 실시간으로 변경될 때 호출되는 메서드"""
        try:
            text = self.wl_input.text()
            if text and text != '-':  # 빈 문자열이나 마이너스 기호만 있는 경우 제외
                wl = int(text)
                self.window_level = wl
                self.wl_slider.blockSignals(True)
                self.wl_slider.setValue(wl)
                self.wl_slider.blockSignals(False)
                # HU Min/Max 업데이트
                self.update_hu_from_window()
                self.update_display()
        except ValueError:
            pass  # 실시간에서는 에러 무시
    
    def update_hu_from_window(self):
        """Window Level/Width에서 HU Min/Max 계산 및 업데이트 (실제 HU 값 기준)"""
        # Window Level/Width는 이미 HU 값이므로 직접 사용
        self.hu_min = self.window_level - self.window_width // 2
        self.hu_max = self.window_level + self.window_width // 2
        
        # HU 슬라이더 범위 동적 조정
        current_min = min(self.hmin_slider.minimum(), self.hu_min - 100)
        current_max = max(self.hmax_slider.maximum(), self.hu_max + 100)
        
        # 범위가 변경되었을 때만 업데이트
        if (self.hu_min < self.hmin_slider.minimum() or self.hu_min > self.hmin_slider.maximum() or
            self.hu_max < self.hmax_slider.minimum() or self.hu_max > self.hmax_slider.maximum()):
            
            self.hmin_slider.setRange(current_min, current_max)
            self.hmax_slider.setRange(current_min, current_max)
            self.hmin_input.setRange(current_min, current_max)
            self.hmax_input.setRange(current_min, current_max)
        
        # HU 컨트롤 업데이트 (신호 연결 해제 후 업데이트하여 무한 루프 방지)
        self.hmin_slider.blockSignals(True)
        self.hmax_slider.blockSignals(True)
        
        self.hmin_slider.setValue(self.hu_min)
        self.hmax_slider.setValue(self.hu_max)
        self.hmin_input.setValue(self.hu_min)
        self.hmax_input.setValue(self.hu_max)
        
        self.hmin_slider.blockSignals(False)
        self.hmax_slider.blockSignals(False)
    
    def update_hu_min(self):
        """HU Min 슬라이더 값이 변경되었을 때 호출되는 메서드"""
        self.hu_min = self.hmin_slider.value()
        # HU Max보다 크지 않도록 제한
        if self.hu_min >= self.hu_max:
            self.hu_min = self.hu_max - 1
            self.hmin_slider.setValue(self.hu_min)
        
        self.hmin_input.blockSignals(True)
        self.hmin_input.setValue(self.hu_min)
        self.hmin_input.blockSignals(False)
        # Window Level/Width 업데이트
        self.update_window_from_hu()
        self.update_display()
    
    def update_hmin_from_spinbox(self):
        """HU Min 스핀박스 값이 변경되었을 때 호출되는 메서드"""
        hu_min = self.hmin_input.value()
        if hu_min < self.hu_max:
            self.hu_min = hu_min
            self.hmin_slider.blockSignals(True)
            self.hmin_slider.setValue(hu_min)
            self.hmin_slider.blockSignals(False)
            # Window Level/Width 업데이트
            self.update_window_from_hu()
            self.update_display()
        else:
            # 잘못된 값이면 원래 값으로 복원
            self.hmin_input.blockSignals(True)
            self.hmin_input.setValue(self.hu_min)
            self.hmin_input.blockSignals(False)
    
    def update_hmin_from_input(self):
        """HU Min 입력 관련 메서드 (호환성 유지)"""
        pass
    
    def update_hmin_from_input_realtime(self):
        """HU Min 실시간 입력 관련 메서드 (호환성 유지)"""
        pass
    
    def update_hmax_from_input(self):
        """HU Max 입력 관련 메서드 (호환성 유지)"""
        pass
    
    def update_hmax_from_input_realtime(self):
        """HU Max 실시간 입력 관련 메서드 (호환성 유지)"""
        pass
    
    def update_hmin_from_input_realtime(self):
        """HU Min 입력 필드 값이 실시간으로 변경될 때 호출되는 메서드"""
        try:
            text = self.hmin_input.text()
            if text and text != '-':  # 빈 문자열이나 마이너스 기호만 있는 경우 제외
                hu_min = int(text)
                if hu_min < self.hu_max:
                    self.hu_min = hu_min
                    self.hmin_slider.blockSignals(True)
                    self.hmin_slider.setValue(hu_min)
                    self.hmin_slider.blockSignals(False)
                    # Window Level/Width 업데이트
                    self.update_window_from_hu()
                    self.update_display()
        except ValueError:
            pass  # 실시간에서는 에러 무시
    
    def update_hu_max(self):
        """HU Max 슬라이더 값이 변경되었을 때 호출되는 메서드"""
        self.hu_max = self.hmax_slider.value()
        # HU Min보다 작지 않도록 제한
        if self.hu_max <= self.hu_min:
            self.hu_max = self.hu_min + 1
            self.hmax_slider.setValue(self.hu_max)
        
        self.hmax_input.blockSignals(True)
        self.hmax_input.setValue(self.hu_max)
        self.hmax_input.blockSignals(False)
        # Window Level/Width 업데이트
        self.update_window_from_hu()
        self.update_display()
    
    def update_hmax_from_spinbox(self):
        """HU Max 스핀박스 값이 변경되었을 때 호출되는 메서드"""
        hu_max = self.hmax_input.value()
        if hu_max > self.hu_min:
            self.hu_max = hu_max
            self.hmax_slider.blockSignals(True)
            self.hmax_slider.setValue(hu_max)
            self.hmax_slider.blockSignals(False)
            # Window Level/Width 업데이트
            self.update_window_from_hu()
            self.update_display()
        else:
            # 잘못된 값이면 원래 값으로 복원
            self.hmax_input.blockSignals(True)
            self.hmax_input.setValue(self.hu_max)
            self.hmax_input.blockSignals(False)
    
    def update_hmax_from_input(self):
        """HU Max 입력 필드에서 엔터 키가 눌렸을 때 호출되는 메서드"""
        try:
            hu_max = int(self.hmax_input.text())
            if hu_max > self.hu_min:
                self.hu_max = hu_max
                self.hmax_slider.setValue(hu_max)
                # Window Level/Width 업데이트
                self.update_window_from_hu()
                self.update_display()
            else:
                # 잘못된 값이면 원래 값으로 복원
                self.hmax_input.setText(str(self.hu_max))
        except ValueError:
            # 잘못된 값이면 원래 값으로 복원
            self.hmax_input.setText(str(self.hu_max))
    
    def update_hmax_from_input_realtime(self):
        """HU Max 입력 필드 값이 실시간으로 변경될 때 호출되는 메서드"""
        try:
            text = self.hmax_input.text()
            if text and text != '-':  # 빈 문자열이나 마이너스 기호만 있는 경우 제외
                hu_max = int(text)
                if hu_max > self.hu_min:
                    self.hu_max = hu_max
                    self.hmax_slider.blockSignals(True)
                    self.hmax_slider.setValue(hu_max)
                    self.hmax_slider.blockSignals(False)
                    # Window Level/Width 업데이트
                    self.update_window_from_hu()
                    self.update_display()
        except ValueError:
            pass  # 실시간에서는 에러 무시
    
    def update_window_from_hu(self):
        """HU Min/Max에서 Window Level/Width 계산 및 업데이트 (실제 HU 값 기준)"""
        self.window_width = self.hu_max - self.hu_min
        self.window_level = (self.hu_min + self.hu_max) // 2
        
        # Window 컨트롤 업데이트 (신호 연결 해제 후 업데이트하여 무한 루프 방지)
        self.wl_slider.blockSignals(True)
        self.ww_slider.blockSignals(True)
        
        # Window Level 범위 동적 조정
        if (self.window_level < self.wl_slider.minimum() or self.window_level > self.wl_slider.maximum()):
            new_min = min(self.wl_slider.minimum(), self.window_level - 500)
            new_max = max(self.wl_slider.maximum(), self.window_level + 500)
            self.wl_slider.setRange(new_min, new_max)
            self.wl_input.setRange(new_min, new_max)
        
        # Window Width 범위 동적 조정
        if self.window_width > self.ww_slider.maximum():
            new_max = max(self.window_width * 2, 4096)
            self.ww_slider.setMaximum(new_max)
            self.ww_input.setMaximum(new_max)
        
        # 값 설정
        self.wl_slider.setValue(self.window_level)
        self.wl_input.setValue(self.window_level)
        self.ww_slider.setValue(self.window_width)
        self.ww_input.setValue(self.window_width)
        
        self.wl_slider.blockSignals(False)
        self.ww_slider.blockSignals(False)
    
    def update_display(self):
        """현재 설정에 따라 이미지를 업데이트하여 표시하는 메서드"""
        if self.current_volume is None:
            return
        
        self.figure.clear()
        # 배경을 검정색으로 강제 설정
        self.figure.patch.set_facecolor('black')
        ax = self.figure.add_subplot(111, facecolor='black')
        
        # 현재 슬라이스 가져오기
        image = self.current_volume[self.current_slice]
        
        # 픽셀 값을 실제 HU 값으로 변환
        hu_image = image * self.rescale_slope + self.rescale_intercept
        
        # 윈도잉 적용 (HU 값 기준)
        vmin = self.window_level - self.window_width // 2
        vmax = self.window_level + self.window_width // 2
        
        # 이미지 표시 (HU 값으로 변환된 이미지 사용)
        ax.imshow(hu_image, cmap='gray', vmin=vmin, vmax=vmax)
        
        # 제목 설정 - 두 그룹의 정보 모두 표시
        title_text = (f"Slice {self.current_slice} | WL: {self.window_level} | WW: {self.window_width} | HU: {self.hu_min} ~ {self.hu_max}")
        ax.set_title(title_text, color='white', fontsize=11)
        ax.axis('off')
        
        # 캔버스 배경도 검정색으로 설정
        self.canvas.figure.patch.set_facecolor('black')
        self.canvas.draw()


def main():
    """애플리케이션 메인 함수 - 애플리케이션을 시작하고 실행하는 함수"""
    app = QApplication(sys.argv)
    
    # 앱 아이콘 설정
    icon_path = os.path.join(os.path.dirname(__file__), "assets", "icon.ico")
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))
    
    viewer = DicomViewer()
    viewer.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()